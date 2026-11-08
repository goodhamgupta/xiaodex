import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CodexBuddyBridge,
  StreamingPcm16MonoResampler,
} from "../src/mac/bridge.mjs";

const VOICE_SESSION = "a1b2c3d4";
const DESKTOP_TURN_ID = "019fcc6c-000e-7d41-a837-3fbcb2d3d9b7";

test("rejects unknown and incomplete Codex connection modes", () => {
  assert.throws(
    () => new CodexBuddyBridge({ codexMode: "deskotp" }),
    /unsupported Codex connection mode/,
  );
  assert.throws(
    () => new CodexBuddyBridge({ codexMode: "proxy" }),
    /requires explicit app-server proxy arguments/,
  );
});

test("resamples 16 kHz PCM to 24 kHz continuously across chunk boundaries", () => {
  const resampler = new StreamingPcm16MonoResampler(16_000, 24_000);
  const first = resampler.append(pcm16Samples([-12_000, 0]));
  const second = resampler.append(pcm16Samples([12_000, 6_000]));
  const tail = resampler.finish();

  assert.deepEqual(readPcm16Samples(first), [-12_000, -4_000]);
  assert.deepEqual(readPcm16Samples(second), [4_000, 12_000, 8_000]);
  assert.deepEqual(readPcm16Samples(tail), [6_000]);
  assert.deepEqual(
    readPcm16Samples(Buffer.concat([first, second, tail])),
    [-12_000, -4_000, 4_000, 12_000, 8_000, 6_000],
  );
  assert.equal(resampler.sourceSamples, 4);
  assert.equal(resampler.outputSamples, 6);
  assert.equal(resampler.finish().length, 0);
});

test("resamples a full 30-second 16 kHz stream without sample-count drift", () => {
  const resampler = new StreamingPcm16MonoResampler(16_000, 24_000);
  const chunk = Buffer.alloc(960);
  let outputBytes = 0;

  // Current firmware emits one 30 ms / 960-byte datagram, so 1,000 chunks is
  // the complete device-side recording limit.
  for (let index = 0; index < 1_000; index += 1) {
    outputBytes += resampler.append(chunk).length;
  }
  outputBytes += resampler.finish().length;

  assert.equal(resampler.sourceSamples, 16_000 * 30);
  assert.equal(resampler.outputSamples, 24_000 * 30);
  assert.equal(outputBytes, 24_000 * 30 * 2);
});

test("coalesces cumulative assistant deltas into bounded device frames", async (t) => {
  const { codex, devices } = await bridgeHarness(t, {
    assistantDeltaIntervalMs: 30,
  });

  codex.emit("notification", assistantDelta("Hello"));
  codex.emit("notification", assistantDelta(", "));
  codex.emit("notification", assistantDelta("world"));

  let frames = assistantFrames(devices);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], {
    cmd: "assistant",
    state: "streaming",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "Hello",
  });

  await waitFor(() => assistantFrames(devices).length === 2);
  frames = assistantFrames(devices);
  assert.equal(frames[1].text, "Hello, world");

  codex.emit("notification", assistantDelta("😀".repeat(1000), {
    itemId: "item-large",
  }));
  const bounded = assistantFrames(devices).find((frame) => frame.itemId === "item-large");
  assert.ok(bounded);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") > 240);
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 640);
  assert.ok(bounded.text.startsWith("..."));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") < 1024);

  codex.emit("notification", assistantDelta("\"\\😀\n".repeat(1000), {
    itemId: "item-escaped",
  }));
  const escaped = assistantFrames(devices).find((frame) => frame.itemId === "item-escaped");
  assert.ok(escaped);
  assert.ok(Buffer.byteLength(`${JSON.stringify(escaped)}\n`, "utf8") < 1024);

  codex.emit("notification", assistantDelta(
    `${"\u0001".repeat(300)}${"\\\"".repeat(300)}tail`,
    {
      threadId: `thread-${"x".repeat(2000)}`,
      turnId: `turn-${"y".repeat(2000)}`,
      itemId: `item-${"z".repeat(2000)}`,
    },
  ));
  const adversarial = assistantFrames(devices).find((frame) =>
    frame.itemId.startsWith("item-") && frame.itemId.length === 80);
  assert.ok(adversarial);
  assert.ok(Buffer.byteLength(`${JSON.stringify(adversarial)}\n`, "utf8") < 1024);
});

test("an authoritative completed item replaces and cancels a queued assistant preview", async (t) => {
  const { bridge, codex, devices } = await bridgeHarness(t, {
    assistantDeltaIntervalMs: 30,
  });

  codex.emit("notification", assistantDelta("Draft"));
  codex.emit("notification", assistantDelta(" response"));
  codex.emit("notification", assistantCompleted("Authoritative final."));

  const frames = assistantFrames(devices);
  assert.deepEqual(frames.map(({ state, text }) => ({ state, text })), [
    { state: "streaming", text: "Draft" },
    { state: "completed", text: "Authoritative final." },
  ]);
  assert.equal(bridge.assistantStreams.size, 0);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(assistantFrames(devices).length, 2);

  codex.emit("notification", assistantDelta("Completed delta fallback", {
    itemId: "item-empty-final",
  }));
  codex.emit("notification", assistantCompleted("", {
    itemId: "item-empty-final",
  }));
  const fallback = assistantFrames(devices).filter((frame) =>
    frame.itemId === "item-empty-final");
  assert.deepEqual(fallback.map(({ state, text }) => ({ state, text })), [
    { state: "streaming", text: "Completed delta fallback" },
    { state: "completed", text: "Completed delta fallback" },
  ]);
});

test("resets a cumulative assistant preview when the Desktop owner rewrites text", async (t) => {
  const { codex, devices } = await bridgeHarness(t, { assistantDeltaIntervalMs: 20 });

  codex.emit("notification", assistantDelta("Draft response"));
  codex.emit("notification", {
    ...assistantDelta(""),
    params: { ...assistantDelta("").params, reset: true },
  });
  await waitFor(() => assistantFrames(devices).length === 2);
  codex.emit("notification", {
    ...assistantDelta("Final answer"),
    params: { ...assistantDelta("Final answer").params, reset: true },
  });

  await waitFor(() => assistantFrames(devices).length === 3);

  const frames = assistantFrames(devices);
  assert.deepEqual(frames.map(({ text }) => text), ["Draft response", "", "Final answer"]);
});

test("assistant deltas do not flood unchanged full snapshots", async (t) => {
  const { codex, devices } = await bridgeHarness(t, {
    assistantDeltaIntervalMs: 20,
  });
  const snapshotsBefore = devices.broadcasts.filter((frame) => frame.cmd !== "assistant").length;

  codex.emit("notification", assistantDelta("one"));
  codex.emit("notification", assistantDelta(" two"));
  codex.emit("notification", assistantDelta(" three"));
  await waitFor(() => assistantFrames(devices).length === 2);

  assert.equal(
    devices.broadcasts.filter((frame) => frame.cmd !== "assistant").length,
    snapshotsBefore,
  );
});

test("isolates concurrent assistant items and completes leftovers with their final delta", async (t) => {
  const { bridge, codex, devices } = await bridgeHarness(t, {
    assistantDeltaIntervalMs: 30,
  });

  codex.emit("notification", assistantDelta("A", { itemId: "item-a" }));
  codex.emit("notification", assistantDelta("B", { itemId: "item-b" }));
  codex.emit("notification", assistantDelta(" two", { itemId: "item-a" }));
  codex.emit("notification", assistantDelta(" two", { itemId: "item-b" }));
  codex.emit("notification", assistantCompleted("Authoritative A", {
    itemId: "item-a",
  }));
  codex.emit("notification", {
    method: "turn/completed",
    params: { turn: { id: "turn-1" } },
  });

  const itemA = assistantFrames(devices).filter((frame) => frame.itemId === "item-a");
  const itemB = assistantFrames(devices).filter((frame) => frame.itemId === "item-b");
  assert.deepEqual(itemA.map(({ state, text }) => ({ state, text })), [
    { state: "streaming", text: "A" },
    { state: "completed", text: "Authoritative A" },
  ]);
  assert.deepEqual(itemB.map(({ state, text }) => ({ state, text })), [
    { state: "streaming", text: "B" },
    { state: "completed", text: "B two" },
  ]);
  assert.equal(bridge.assistantStreams.size, 0);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(assistantFrames(devices).length, 4);
});

test("stopping the bridge clears pending assistant delta timers", async (t) => {
  const { bridge, codex, devices } = await bridgeHarness(t, {
    assistantDeltaIntervalMs: 30,
  });
  codex.emit("notification", assistantDelta("first"));
  codex.emit("notification", assistantDelta(" queued"));
  assert.equal(assistantFrames(devices).length, 1);

  bridge.stop();
  assert.equal(bridge.assistantStreams.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(assistantFrames(devices).length, 1);
});

test("replays active and recent completed assistant frames after reconnect", async (t) => {
  const { codex, devices } = await bridgeHarness(t);

  codex.emit("notification", assistantDelta("Still working"));
  const activeReconnect = new FakeConnection();
  activeReconnect.name = "active-reconnect";
  devices.emit("authenticated", activeReconnect);
  assert.deepEqual(
    activeReconnect.sent.filter((frame) => frame.cmd === "assistant"),
    [{
      cmd: "assistant",
      state: "streaming",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "Still working",
    }],
  );

  codex.emit("notification", assistantCompleted("Finished.", {
    phase: "final_answer",
  }));
  const completedReconnect = new FakeConnection();
  completedReconnect.name = "completed-reconnect";
  devices.emit("authenticated", completedReconnect);
  assert.deepEqual(
    completedReconnect.sent.filter((frame) => frame.cmd === "assistant"),
    [{
      cmd: "assistant",
      state: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "Finished.",
      phase: "final_answer",
    }],
  );
});

test("replays the most recently updated concurrent assistant item last", async (t) => {
  const { codex, devices } = await bridgeHarness(t);
  codex.emit("notification", assistantDelta("A", { itemId: "item-a" }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  codex.emit("notification", assistantDelta("B", { itemId: "item-b" }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  codex.emit("notification", assistantDelta(" latest", { itemId: "item-a" }));

  const reconnect = new FakeConnection();
  reconnect.name = "concurrent-reconnect";
  devices.emit("authenticated", reconnect);

  const frames = reconnect.sent.filter((frame) => frame.cmd === "assistant");
  assert.deepEqual(frames.map((frame) => frame.itemId), ["item-b", "item-a"]);
  assert.equal(frames.at(-1).text, "A latest");
});

test("closes active assistant streams if the app-server exits", async (t) => {
  const { bridge, codex, devices } = await bridgeHarness(t);
  codex.emit("notification", assistantDelta("Partial response"));

  codex.emit("exit", { code: 1, signal: null });

  const frames = assistantFrames(devices);
  assert.deepEqual(frames.map(({ state, text }) => ({ state, text })), [
    { state: "streaming", text: "Partial response" },
    { state: "completed", text: "Partial response" },
  ]);
  assert.equal(bridge.assistantStreams.size, 0);
});

test("expires an assistant stream that loses both completion events", async (t) => {
  const { bridge, codex, devices } = await bridgeHarness(t, {
    assistantStreamTimeoutMs: 20,
  });
  codex.emit("notification", assistantDelta("Orphaned partial"));

  await waitFor(() => assistantFrames(devices).length === 2);

  assert.deepEqual(
    assistantFrames(devices).map(({ state, text }) => ({ state, text })),
    [
      { state: "streaming", text: "Orphaned partial" },
      { state: "completed", text: "Orphaned partial" },
    ],
  );
  assert.equal(bridge.assistantStreams.size, 0);
});

test("relays sequenced onboard PCM and returns transcription states", async (t) => {
  const { devices, voice, connection, logs } = await bridgeHarness(t);
  const first = Buffer.alloc(1_920);
  first.writeInt16LE(1, 0);
  first.writeInt16LE(2, 2);
  const second = Buffer.from([3, 0]);

  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, first), connection);
  devices.emit("message", voiceAudio(1, second), connection);
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => Buffer.from(audio, "base64")),
    [first, second],
  );
  assert.equal(voice.calls[0].finishCalls, 0);
  devices.emit("message", voiceStop(2, first.length / 2 + second.length / 2), connection);
  await waitFor(() => connection.sent.some((message) => message.state === "submitted"));

  assert.deepEqual(
    connection.sent.filter((message) => message.ack === "voice").map((message) => message.state),
    ["recording", "transcribing", "transcribed", "submitted"],
  );
  const transcribed = connection.sent.find((message) => message.state === "transcribed");
  assert.equal(transcribed.text, "speak status");
  assert.equal(transcribed.submitted, false);
  assert.equal(
    connection.sent.some((message) => message.ack === "voice_audio" && message.ok),
    false,
  );
  assert.equal(voice.calls.length, 1);
  assert.equal(voice.calls[0].options.sampleRate, 24_000);
  assert.equal(voice.calls[0].options.numChannels, 1);
  assert.equal(voice.calls[0].options.submit, true);
  assert.equal(Object.hasOwn(voice.calls[0].options, "threadId"), false);
  assert.equal(voice.calls[0].finishCalls, 1);
  assert.equal(connection.sent.at(-1).text, "speak status");

  assert.match(
    logs.find((line) => line.includes("voice start ACK")),
    /^device test-stick voice start ACK: latency=\d+\.\dms$/,
  );
  const firstPcmLogs = logs.filter((line) => line.includes("voice first PCM"));
  assert.equal(firstPcmLogs.length, 1);
  assert.match(
    firstPcmLogs[0],
    /^device test-stick voice first PCM: latency=\d+\.\dms, after_ack=\d+\.\dms$/,
  );
  assert.match(
    logs.find((line) => line.includes("voice stop:")),
    /^device test-stick voice stop: wall=\d+\.\dms, pcm=40\.0ms, source_rate=24000Hz, samples=961, bytes=1922, realtime_bytes=1922, chunks=2, rms=\d+, peak=\d+$/,
  );
});

test("reorders authenticated raw UDP PCM before forwarding it to Realtime", async (t) => {
  const { devices, voice, connection } = await bridgeHarness(t);
  const first = Buffer.from([1, 0, 2, 0]);
  const second = Buffer.from([3, 0]);

  devices.emit("message", voiceStart({ transport: "wifi_udp" }), connection);
  devices.emit("datagram", voiceDatagram(1, second), {
    address: "::ffff:192.0.2.10",
  });
  assert.deepEqual(voice.calls[0].appends, []);

  devices.emit("datagram", voiceDatagram(0, first), {
    address: "192.0.2.10",
  });
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => Buffer.from(audio, "base64")),
    [first, second],
  );

  devices.emit("message", voiceStop(2, 3), connection);
  await waitFor(() => connection.sent.some((message) => message.state === "submitted"));
  assert.equal(voice.calls[0].finishCalls, 1);
});

test("streams ordered 16 kHz TCP PCM and validates the full recording", async (t) => {
  const { devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart({ transport: "wifi", sampleRate: 16_000 }), connection);
  devices.emit("message", voiceAudio(0, pcm16Samples([0, 3000])), connection);
  devices.emit("message", voiceAudio(1, pcm16Samples([6000, 9000])), connection);
  devices.emit("message", voiceStop(2, 4), connection);
  await waitFor(() => connection.sent.some(m => m.state === "submitted"));
  assert.deepEqual(readPcm16Samples(Buffer.concat(
    voice.calls[0].appends.map(a => Buffer.from(a, "base64")),
  )), [0, 2000, 4000, 6000, 8000, 9000]);
  assert.equal(voice.calls[0].finishCalls, 1);
});

test("resamples 16 kHz UDP PCM while validating source-domain stop metadata", async (t) => {
  const { bridge, devices, voice, connection, logs } = await bridgeHarness(t);
  const first = pcm16Samples([0, 3_000]);
  const second = pcm16Samples([6_000, 9_000]);

  devices.emit("message", voiceStart({
    transport: "wifi_udp",
    sampleRate: 16_000,
  }), connection);
  const session = bridge.voiceSessions.get(connection);
  assert.equal(session.sourceSampleRate, 16_000);
  assert.equal(session.maxSourcePcmBytes, 16_000 * 2 * 30);
  assert.equal(voice.calls[0].options.sampleRate, 24_000);

  devices.emit("datagram", voiceDatagram(1, second), {
    address: "192.0.2.10",
  });
  devices.emit("datagram", voiceDatagram(0, first), {
    address: "192.0.2.10",
  });
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => readPcm16Samples(Buffer.from(audio, "base64"))),
    [
      [0, 2_000],
      [4_000, 6_000, 8_000],
    ],
  );

  devices.emit("message", voiceStop(2, 4), connection);
  await waitFor(() => connection.sent.some((message) => message.state === "submitted"));
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => readPcm16Samples(Buffer.from(audio, "base64"))),
    [
      [0, 2_000],
      [4_000, 6_000, 8_000],
      [9_000],
    ],
  );
  assert.deepEqual(
    readPcm16Samples(Buffer.concat(
      voice.calls[0].appends.map((audio) => Buffer.from(audio, "base64")),
    )),
    [0, 2_000, 4_000, 6_000, 8_000, 9_000],
  );
  assert.match(
    logs.find((line) => line.includes("voice stop:")),
    /^device test-stick voice stop: wall=\d+\.\dms, pcm=0\.3ms, source_rate=16000Hz, samples=4, bytes=8, realtime_bytes=12, chunks=2, rms=5612, peak=9000$/,
  );
});

test("rejects a 16 kHz UDP stop count expressed in resampled samples", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart({
    transport: "wifi_udp",
    sampleRate: 16_000,
  }), connection);
  devices.emit("datagram", voiceDatagram(0, pcm16Samples([1_000, 2_000])), {
    address: "192.0.2.10",
  });
  devices.emit("message", voiceStop(1, 3), connection);

  assert.match(connection.sent.at(-1).error, /sample count must be 2/);
  assert.equal(voice.calls[0].finishCalls, 0);
  assert.equal(voice.calls[0].abortCalls, 1);
  assert.equal(bridge.voiceSessions.size, 0);
});

test("drops UDP audio with the wrong session or TCP source address", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart({ transport: "wifi_udp" }), connection);

  devices.emit("datagram", voiceDatagram(0, Buffer.from([1, 0]), {
    session: "deadbeef",
  }), { address: "192.0.2.10" });
  devices.emit("datagram", voiceDatagram(0, Buffer.from([2, 0])), {
    address: "192.0.2.99",
  });

  assert.deepEqual(voice.calls[0].appends, []);
  assert.equal(bridge.voiceSessions.get(connection).nextSeq, 0);
  assert.equal(connection.sent.some((message) => message.ack === "voice_audio"), false);

  devices.emit("datagram", voiceDatagram(0, Buffer.from([3, 0])), {
    address: "192.0.2.10",
  });
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => Buffer.from(audio, "base64")),
    [Buffer.from([3, 0])],
  );
});

test("waits briefly for UDP stop races and commits only once on duplicate stop", async (t) => {
  const { devices, voice, connection } = await bridgeHarness(t, {
    voiceUdpStopGraceMs: 60,
  });
  const first = Buffer.from([1, 0]);
  const second = Buffer.from([2, 0]);

  devices.emit("message", voiceStart({ transport: "wifi_udp" }), connection);
  devices.emit("datagram", voiceDatagram(0, first), { address: "192.0.2.10" });
  devices.emit("message", voiceStop(2, 2), connection);
  devices.emit("message", voiceStop(2, 2), connection);

  assert.equal(voice.calls[0].finishCalls, 0);
  assert.equal(connection.sent.at(-1).state, "recording");
  setTimeout(() => {
    devices.emit("datagram", voiceDatagram(1, second), { address: "192.0.2.10" });
  }, 10);

  await waitFor(() => connection.sent.some((message) => message.state === "submitted"));
  assert.deepEqual(
    voice.calls[0].appends.map((audio) => Buffer.from(audio, "base64")),
    [first, second],
  );
  assert.equal(voice.calls[0].finishCalls, 1);
  assert.equal(
    connection.sent.filter((message) => message.state === "transcribing").length,
    1,
  );
  assert.equal(
    connection.sent.filter((message) => message.state === "submitted").length,
    1,
  );
});

test("fails one UDP turn cleanly when a packet remains missing after stop grace", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t, {
    voiceUdpStopGraceMs: 10,
  });

  devices.emit("message", voiceStart({ transport: "wifi_udp" }), connection);
  devices.emit("datagram", voiceDatagram(0, Buffer.from([1, 0])), {
    address: "192.0.2.10",
  });
  devices.emit("message", voiceStop(2, 2), connection);

  await waitFor(() => connection.sent.some((message) =>
    message.ack === "voice" && message.state === "error"));
  const terminalErrors = connection.sent.filter((message) =>
    message.ack === "voice" && message.state === "error");
  assert.equal(terminalErrors.length, 1);
  assert.match(terminalErrors[0].error, /stop sequence must be 1/);
  assert.equal(voice.calls[0].finishCalls, 0);
  assert.equal(voice.calls[0].abortCalls, 1);
  assert.equal(bridge.voiceSessions.size, 0);
});

test("shows the authoritative transcript while Codex submission is pending", async (t) => {
  const voice = new DeferredSubmissionVoice();
  const { devices, connection } = await bridgeHarness(t, { voice });

  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);

  await waitFor(() => connection.sent.some((message) => message.state === "transcribed"));
  const interimStates = connection.sent
    .filter((message) => message.ack === "voice")
    .map((message) => message.state);
  assert.deepEqual(interimStates, ["recording", "transcribing", "transcribed"]);
  assert.equal(connection.sent.some((message) => message.state === "submitted"), false);
  assert.equal(
    connection.sent.find((message) => message.state === "transcribed").text,
    "authoritative final transcript",
  );

  voice.completeSubmission();
  await waitFor(() => connection.sent.some((message) => message.state === "submitted"));
});

test("reports a submission failure after showing the authoritative transcript", async (t) => {
  const voice = new DeferredSubmissionVoice();
  const { devices, connection } = await bridgeHarness(t, { voice });

  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);

  await waitFor(() => connection.sent.some((message) => message.state === "transcribed"));
  voice.failSubmission(new Error("Codex turn/start failed"));
  await waitFor(() => connection.sent.some((message) => message.state === "error"));
  assert.deepEqual(
    connection.sent
      .filter((message) => message.ack === "voice")
      .map((message) => message.state),
    ["recording", "transcribing", "transcribed", "error"],
  );
});

test("streams throttled partial transcripts back to the stick before release", async (t) => {
  const { devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);

  voice.calls[0].emitDelta("show ");
  voice.calls[0].emitDelta("repository status");

  const partials = connection.sent.filter((message) =>
    message.ack === "voice" &&
    message.state === "recording" &&
    message.text);
  assert.equal(partials.length, 1);
  assert.equal(partials[0].text, "show");

  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);
  assert.equal(
    connection.sent.findLast((message) => message.state === "transcribing").text,
    "show repository status",
  );
});

test("bounds UTF-8 live transcript previews below the device receive limit", async (t) => {
  const { devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);

  voice.calls[0].emitDelta(`${"\\\"語".repeat(300)} newest words`);
  const partial = connection.sent.findLast((message) =>
    message.ack === "voice" && message.state === "recording" && message.text);

  assert.ok(partial.text.startsWith("..."));
  assert.ok(partial.text.endsWith("newest words"));
  assert.ok(Buffer.byteLength(partial.text, "utf8") <= 320);
  assert.ok(Buffer.byteLength(`${JSON.stringify(partial)}\n`, "utf8") < 1024);
});

test("rejects legacy Mac capture and device-selected task targets", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);

  devices.emit("message", { cmd: "voice", duration: 2 }, connection);
  assert.match(connection.sent.at(-1).error, /Mac microphone capture is not supported/);

  devices.emit("message", {
    ...voiceStart(),
    threadId: "device-controlled-thread",
  }, connection);
  assert.match(connection.sent.at(-1).error, /device-supplied voice thread ids are not allowed/);
  assert.equal(bridge.voiceSessions.size, 0);
  assert.equal(voice.calls.length, 0);
});

test("requires authentication and the fixed WiFi PCM format", async (t) => {
  const { bridge, devices } = await bridgeHarness(t);
  const unauthenticated = new FakeConnection({ authenticated: false });
  devices.emit("message", voiceStart(), unauthenticated);
  assert.match(unauthenticated.sent.at(-1).error, /authentication required/);

  const connection = new FakeConnection();
  const invalidStarts = [
    { sampleRate: 8_000 },
    { channels: 2 },
    { format: "wav" },
    { transport: "usb" },
    { session: "not-hex" },
  ];
  for (const override of invalidStarts) {
    devices.emit("message", voiceStart(override), connection);
    assert.equal(connection.sent.at(-1).ok, false);
  }
  assert.equal(bridge.voiceSessions.size, 0);
});

test("rejects invalid audio chunks and immediately clears corrupted sessions", async (t) => {
  const duplicateStart = await bridgeHarness(t);
  duplicateStart.devices.emit("message", voiceStart(), duplicateStart.connection);
  duplicateStart.devices.emit("message", voiceStart(), duplicateStart.connection);
  assert.equal(duplicateStart.connection.sent.at(-1).state, "recording");
  assert.equal(duplicateStart.bridge.voiceSessions.size, 1);
  assert.equal(duplicateStart.voice.calls.length, 1);

  const duplicateChunk = await bridgeHarness(t);
  duplicateChunk.devices.emit("message", voiceStart(), duplicateChunk.connection);
  duplicateChunk.devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), duplicateChunk.connection);
  duplicateChunk.devices.emit("message", voiceAudio(0, Buffer.from([2, 0])), duplicateChunk.connection);
  assert.equal(duplicateChunk.connection.sent.at(-1).expectedSeq, 1);
  assert.equal(duplicateChunk.bridge.voiceSessions.size, 0);

  const invalidBase64 = await bridgeHarness(t);
  invalidBase64.devices.emit("message", voiceStart(), invalidBase64.connection);
  invalidBase64.devices.emit("message", {
    ...voiceAudio(0, Buffer.from([2, 0])),
    data: "%%%!=",
  }, invalidBase64.connection);
  assert.match(invalidBase64.connection.sent.at(-1).error, /base64/);
  assert.equal(invalidBase64.bridge.voiceSessions.size, 0);

  const oversizedChunk = await bridgeHarness(t);
  oversizedChunk.devices.emit("message", voiceStart(), oversizedChunk.connection);
  oversizedChunk.devices.emit("message", voiceAudio(0, Buffer.alloc(1_922)), oversizedChunk.connection);
  assert.match(oversizedChunk.connection.sent.at(-1).error, /1920 bytes/);
  assert.equal(oversizedChunk.bridge.voiceSessions.size, 0);

  const overLimit = await bridgeHarness(t, { voiceMaxPcmBytes: 4 });
  overLimit.devices.emit("message", voiceStart(), overLimit.connection);
  overLimit.devices.emit("message", voiceAudio(0, Buffer.alloc(4)), overLimit.connection);
  overLimit.devices.emit("message", voiceAudio(1, Buffer.from([3, 0])), overLimit.connection);
  assert.match(overLimit.connection.sent.at(-1).error, /30 second limit/);
  assert.equal(overLimit.bridge.voiceSessions.size, 0);
});

test("resynchronizes abandoned sessions and accepts the replacement immediately", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceStart({ session: "b2c3d4e5" }), connection);

  assert.equal(voice.calls.length, 2);
  assert.equal(voice.calls[0].abortCalls, 1);
  assert.equal(connection.sent.at(-1).state, "recording");
  assert.equal(connection.sent.at(-1).session, "b2c3d4e5");
  assert.equal(bridge.voiceSessions.get(connection).id, "b2c3d4e5");

  devices.emit("message", voiceAudio(0, Buffer.from([7, 0]), {
    session: "b2c3d4e5",
  }), connection);
  assert.deepEqual(
    voice.calls[1].appends.map((audio) => Buffer.from(audio, "base64")),
    [Buffer.from([7, 0])],
  );
  assert.equal(connection.sent.some((message) => /does not match/.test(message.error || "")), false);
});

test("fatal stop validation resets the recording for the next session", async (t) => {
  const badSequence = await bridgeHarness(t);
  badSequence.devices.emit("message", voiceStart(), badSequence.connection);
  badSequence.devices.emit(
    "message",
    voiceAudio(0, Buffer.from([1, 0, 2, 0])),
    badSequence.connection,
  );
  badSequence.devices.emit("message", voiceStop(0, 2), badSequence.connection);
  assert.match(badSequence.connection.sent.at(-1).error, /stop sequence must be 1/);
  assert.equal(badSequence.bridge.voiceSessions.size, 0);
  assert.equal(badSequence.voice.calls[0].abortCalls, 1);

  badSequence.devices.emit(
    "message",
    voiceStart({ session: "b2c3d4e5" }),
    badSequence.connection,
  );
  assert.equal(badSequence.connection.sent.at(-1).state, "recording");

  const badSamples = await bridgeHarness(t);
  badSamples.devices.emit("message", voiceStart(), badSamples.connection);
  badSamples.devices.emit(
    "message",
    voiceAudio(0, Buffer.from([1, 0, 2, 0])),
    badSamples.connection,
  );
  badSamples.devices.emit("message", voiceStop(1, 1), badSamples.connection);
  assert.match(badSamples.connection.sent.at(-1).error, /sample count must be 2/);
  assert.equal(badSamples.bridge.voiceSessions.size, 0);
});

test("a mismatched audio stream resets stale state instead of deadlocking retries", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0]), {
    session: "b2c3d4e5",
  }), connection);

  assert.match(connection.sent.at(-1).error, /session id does not match/);
  assert.equal(connection.sent.at(-1).expectedSession, VOICE_SESSION);
  assert.equal(bridge.voiceSessions.size, 0);
  assert.equal(voice.calls[0].abortCalls, 1);

  devices.emit("message", voiceStart({ session: "b2c3d4e5" }), connection);
  assert.equal(connection.sent.at(-1).state, "recording");
  assert.equal(bridge.voiceSessions.get(connection).id, "b2c3d4e5");
});

test("cancel is idempotent and a late cancel cannot tear down a new session", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", {
    cmd: "voice",
    action: "cancel",
    session: VOICE_SESSION,
  }, connection);
  assert.equal(connection.sent.at(-1).state, "cancelled");
  assert.equal(bridge.voiceSessions.size, 0);
  assert.equal(voice.calls[0].abortCalls, 1);

  devices.emit("message", voiceStart({ session: "b2c3d4e5" }), connection);
  devices.emit("message", {
    cmd: "voice",
    action: "cancel",
    session: VOICE_SESSION,
  }, connection);
  assert.equal(connection.sent.at(-1).state, "cancelled");
  assert.equal(bridge.voiceSessions.get(connection).id, "b2c3d4e5");
  assert.equal(voice.calls[1].abortCalls, 0);
});

test("a same-name reconnect retires the half-open connection and its voice session", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);
  const replacement = new FakeConnection();
  devices.emit("authenticated", replacement);

  assert.equal(connection.terminateCalls, 1);
  assert.equal(voice.calls[0].abortCalls, 1);
  assert.equal(bridge.voiceSessions.size, 0);
  assert.equal(
    replacement.sent.some((message) =>
      message.state === "cancelled" && message.session === VOICE_SESSION),
    true,
  );

  devices.emit("message", voiceStart({ session: "b2c3d4e5" }), replacement);
  assert.equal(replacement.sent.at(-1).state, "recording");
  assert.equal(bridge.voiceSessions.get(replacement).id, "b2c3d4e5");

  devices.emit("message", voiceStart({ session: "c3d4e5f6" }), connection);
  assert.equal(voice.calls.length, 2);
  assert.equal(bridge.voiceSessions.get(replacement).id, "b2c3d4e5");
});

test("a reconnect during submission releases the device without stale completion", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t);
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);
  assert.equal(bridge.voiceSessions.get(connection).status, "transcribed");

  const replacement = new FakeConnection();
  devices.emit("authenticated", replacement);
  assert.equal(
    replacement.sent.some((message) =>
      message.state === "cancelled" && message.session === VOICE_SESSION),
    true,
  );
  assert.equal(bridge.voiceSessions.size, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    connection.sent.some((message) => message.state === "submitted"),
    false,
  );
});

test("returns errors from device-audio transcription", async (t) => {
  const voice = new FakeVoice({ error: new Error("transcription unavailable") });
  const { devices, connection } = await bridgeHarness(t, { voice });
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);
  await waitFor(() => connection.sent.some((message) => message.state === "error"));

  assert.equal(connection.sent.some((message) => message.state === "transcribing"), true);
  assert.match(connection.sent.at(-1).error, /transcription unavailable/);
});

test("turns a Realtime no-speech result into actionable device guidance", async (t) => {
  const error = new Error(
    "OpenAI realtime transcription detected no speech in the committed audio",
  );
  error.code = "NO_SPEECH";
  const voice = new FakeVoice({ error });
  const { devices, connection } = await bridgeHarness(t, { voice });
  devices.emit("message", voiceStart(), connection);
  devices.emit("message", voiceAudio(0, Buffer.from([1, 0])), connection);
  devices.emit("message", voiceStop(1, 1), connection);
  await waitFor(() => connection.sent.some((message) => message.state === "error"));

  assert.equal(
    connection.sent.at(-1).error,
    "no speech detected - hold A while speaking",
  );
});

test("cleans voice sessions on timeout and disconnect", async (t) => {
  const { bridge, devices, voice, connection } = await bridgeHarness(t, {
    voiceSessionTimeoutMs: 20,
  });
  devices.emit("message", voiceStart(), connection);
  await waitFor(() => connection.sent.some((message) => /timed out/.test(message.error || "")));
  assert.equal(bridge.voiceSessions.size, 0);

  const disconnected = new FakeConnection();
  devices.emit("message", voiceStart({ session: "deadbeef" }), disconnected);
  assert.equal(bridge.voiceSessions.size, 1);
  devices.emit("disconnect", disconnected);
  assert.equal(bridge.voiceSessions.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(disconnected.sent.some((message) => /timed out/.test(message.error || "")), false);
  assert.equal(voice.calls.length, 2);
  assert.equal(voice.calls[0].abortCalls, 1);
  assert.equal(voice.calls[1].abortCalls, 1);
});

test("keeps a Desktop approval pending until its correlated log output", async (t) => {
  const desktopSession = new FakeDesktopSession();
  const desktopApprovals = {
    calls: [],
    async respond(decision, context) { this.calls.push({ decision, context }); },
  };
  const { bridge, devices, connection } = await bridgeHarness(t, {
    desktopSession,
    desktopApprovals,
  });
  const sessionId = "019fcc30-7810-71a2-a555-a0a05e1784a5";
  desktopSession.emit("event", desktopApprovalEvent("call-desktop-1", sessionId));
  assert.notEqual(bridge.snapshot.approvalFor("call-desktop-1"), null);

  devices.emit("message", {
    cmd: "permission",
    id: "call-desktop-1",
    decision: "once",
  }, connection);
  await waitFor(() => connection.sent.some((message) => message.ack === "permission"));

  assert.deepEqual(desktopApprovals.calls, [{
    decision: "once",
    context: {
      threadId: sessionId,
      callId: "call-desktop-1",
      turnId: DESKTOP_TURN_ID,
      command: "ls -la",
      reason: "May I list the workspace files?",
    },
  }]);
  assert.equal(
    connection.sent.find((message) => message.ack === "permission").ok,
    true,
  );
  assert.notEqual(bridge.snapshot.approvalFor("call-desktop-1"), null);

  desktopSession.emit("event", {
    __sessionId: sessionId,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call-desktop-1",
      output: "Script completed",
    },
  });
  assert.equal(bridge.snapshot.approvalFor("call-desktop-1"), null);
});

test("deduplicates repeated Desktop decisions until correlated output arrives", async (t) => {
  const desktopSession = new FakeDesktopSession();
  let finishApproval;
  const approvalPending = new Promise((resolve) => { finishApproval = resolve; });
  const desktopApprovals = {
    calls: [],
    async respond(decision, context) {
      this.calls.push({ decision, context });
      await approvalPending;
    },
  };
  const { bridge, devices, connection } = await bridgeHarness(t, {
    desktopSession,
    desktopApprovals,
  });
  const sessionId = "019fcc30-7810-71a2-a555-a0a05e1784a5";
  desktopSession.emit("event", desktopApprovalEvent("call-desktop-repeat", sessionId));

  const accept = {
    cmd: "permission",
    id: "call-desktop-repeat",
    decision: "once",
  };
  devices.emit("message", accept, connection);
  devices.emit("message", accept, connection);
  devices.emit("message", { ...accept, decision: "deny" }, connection);

  await waitFor(() => desktopApprovals.calls.length === 1);
  await waitFor(() => connection.sent.some((message) =>
    message.ack === "permission" && message.ok === false));
  assert.deepEqual(desktopApprovals.calls, [{
    decision: "once",
    context: {
      threadId: sessionId,
      callId: "call-desktop-repeat",
      turnId: DESKTOP_TURN_ID,
      command: "ls -la",
      reason: "May I list the workspace files?",
    },
  }]);
  assert.match(
    connection.sent.find((message) => message.ack === "permission" && !message.ok).error,
    /different decision was already submitted/,
  );
  assert.equal(
    connection.sent.filter((message) => message.ack === "permission" && message.ok).length,
    0,
  );
  assert.equal(bridge.desktopApprovalActions.size, 1);

  finishApproval();
  await waitFor(() =>
    connection.sent.filter((message) => message.ack === "permission" && message.ok).length === 2);
  assert.equal(desktopApprovals.calls.length, 1);
  assert.equal(bridge.desktopApprovalActions.size, 1);

  desktopSession.emit("event", {
    __sessionId: sessionId,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call-desktop-repeat",
      output: "Script completed",
    },
  });
  assert.equal(bridge.snapshot.approvalFor("call-desktop-repeat"), null);
  assert.equal(bridge.desktopApprovalActions.size, 0);
});

test("keeps a Desktop action locked after an ambiguous post-dispatch failure", async (t) => {
  const desktopSession = new FakeDesktopSession();
  const ambiguous = new Error("Desktop IPC approval decision timed out");
  ambiguous.desktopDecisionDispatched = true;
  const desktopApprovals = {
    calls: 0,
    async respond() {
      this.calls += 1;
      throw ambiguous;
    },
  };
  const { bridge, devices, connection } = await bridgeHarness(t, {
    desktopSession,
    desktopApprovals,
  });
  const sessionId = "019fcc30-7810-71a2-a555-a0a05e1784a5";
  desktopSession.emit("event", desktopApprovalEvent("call-desktop-ambiguous", sessionId));
  const message = {
    cmd: "permission",
    id: "call-desktop-ambiguous",
    decision: "once",
  };

  devices.emit("message", message, connection);
  await waitFor(() => connection.sent.filter((frame) => frame.ack === "permission").length === 1);
  devices.emit("message", message, connection);
  await waitFor(() => connection.sent.filter((frame) => frame.ack === "permission").length === 2);

  assert.equal(desktopApprovals.calls, 1);
  assert.equal(bridge.desktopApprovalActions.size, 1);
  assert.equal(
    connection.sent.filter((frame) => frame.ack === "permission").every((frame) => !frame.ok),
    true,
  );

  desktopSession.emit("event", {
    __sessionId: sessionId,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call-desktop-ambiguous",
      output: "Script completed",
    },
  });
  assert.equal(bridge.desktopApprovalActions.size, 0);
});

test("fails closed when Desktop has more than one pending approval", async (t) => {
  const desktopSession = new FakeDesktopSession();
  const desktopApprovals = {
    calls: [],
    async respond(decision) { this.calls.push(decision); },
  };
  const { bridge, devices, connection } = await bridgeHarness(t, {
    desktopSession,
    desktopApprovals,
  });
  desktopSession.emit("event", desktopApprovalEvent("call-desktop-a", "session-a"));
  desktopSession.emit("event", desktopApprovalEvent("call-desktop-b", "session-b"));

  devices.emit("message", {
    cmd: "permission",
    id: "call-desktop-a",
    decision: "once",
  }, connection);
  await waitFor(() => connection.sent.some((message) => message.ack === "permission"));

  const ack = connection.sent.find((message) => message.ack === "permission");
  assert.equal(ack.ok, false);
  assert.match(ack.error, /multiple Desktop approvals/);
  assert.deepEqual(desktopApprovals.calls, []);
  assert.notEqual(bridge.snapshot.approvalFor("call-desktop-a"), null);
  assert.notEqual(bridge.snapshot.approvalFor("call-desktop-b"), null);
});

test("strictly rejects invalid permission decisions", async (t) => {
  const codex = new FakeCodex();
  const devices = new FakeDevices();
  const bridge = new CodexBuddyBridge({
    codex,
    devices,
    voice: new FakeVoice(),
    log: () => {},
    pollMs: 60_000,
    heartbeatMs: 60_000,
  });
  const connection = new FakeConnection();
  t.after(() => bridge.stop());

  await bridge.start();
  codex.emit("serverRequest", {
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: { command: "echo safe" },
  });

  devices.emit("message", {
    cmd: "permission",
    id: "approval-1",
    decision: "always",
  }, connection);
  await waitFor(() => connection.sent.length >= 1);

  assert.deepEqual(connection.sent[0], {
    ack: "permission",
    ok: false,
    error: "invalid permission decision",
  });
  assert.equal(codex.responses.length, 0);
  assert.notEqual(bridge.snapshot.approvalFor("approval-1"), null);

  devices.emit("message", {
    cmd: "permission",
    id: "approval-1",
    decision: "once",
  }, connection);
  await waitFor(() => codex.responses.length === 1);
  assert.deepEqual(codex.responses[0], {
    id: "approval-1",
    result: { decision: "accept" },
  });
});

test("keeps an app-server approval visible when its owner rejects the decision", async (t) => {
  const codex = new FakeCodex();
  codex.respond = async () => {
    throw new Error("Desktop task owner rejected the decision");
  };
  const devices = new FakeDevices();
  const bridge = new CodexBuddyBridge({
    codex,
    devices,
    voice: new FakeVoice(),
    log: () => {},
    pollMs: 60_000,
    heartbeatMs: 60_000,
  });
  const connection = new FakeConnection();
  t.after(() => bridge.stop());

  await bridge.start();
  codex.emit("serverRequest", {
    id: "approval-owner-failure",
    method: "item/commandExecution/requestApproval",
    params: { command: "echo safe" },
  });
  devices.emit("message", {
    cmd: "permission",
    id: "approval-owner-failure",
    decision: "once",
  }, connection);

  await waitFor(() => connection.sent.some((message) => message.ack === "permission"));
  const ack = connection.sent.find((message) => message.ack === "permission");
  assert.equal(ack.ok, false);
  assert.match(ack.error, /owner rejected/);
  assert.notEqual(bridge.snapshot.approvalFor("approval-owner-failure"), null);
});

test("deduplicates repeated owner decisions and rejects a conflicting press", async (t) => {
  const codex = new FakeCodex();
  let releaseDecision;
  const decision = new Promise((resolve) => { releaseDecision = resolve; });
  const calls = [];
  codex.respond = async (id, result) => {
    calls.push({ id, result });
    return decision;
  };
  const devices = new FakeDevices();
  const bridge = new CodexBuddyBridge({
    codex,
    devices,
    voice: new FakeVoice(),
    log: () => {},
    pollMs: 60_000,
    heartbeatMs: 60_000,
  });
  const connection = new FakeConnection();
  t.after(() => bridge.stop());
  await bridge.start();
  codex.emit("serverRequest", {
    id: "approval-locked",
    method: "item/commandExecution/requestApproval",
    params: { command: "echo safe" },
  });

  const accept = { cmd: "permission", id: "approval-locked", decision: "once" };
  devices.emit("message", accept, connection);
  devices.emit("message", accept, connection);
  devices.emit("message", { ...accept, decision: "deny" }, connection);
  await waitFor(() => connection.sent.some((message) =>
    message.ack === "permission" && message.ok === false));

  assert.equal(calls.length, 1);
  assert.match(
    connection.sent.find((message) => message.ack === "permission" && !message.ok).error,
    /different decision/,
  );
  releaseDecision();
  await waitFor(() => connection.sent.filter((message) =>
    message.ack === "permission" && message.ok).length === 2);
  assert.equal(bridge.snapshot.approvalFor("approval-locked"), null);
});

function assistantDelta(delta, overrides = {}) {
  return {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta,
      ...overrides,
    },
  };
}

function assistantCompleted(text, overrides = {}) {
  const { phase = null, ...paramsOverrides } = overrides;
  const itemId = paramsOverrides.itemId || "item-1";
  return {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      ...paramsOverrides,
      item: {
        id: itemId,
        type: "agentMessage",
        text,
        phase,
      },
    },
  };
}

function assistantFrames(devices) {
  return devices.broadcasts.filter((frame) => frame.cmd === "assistant");
}

function desktopApprovalEvent(callId, sessionId) {
  return {
    __sessionId: sessionId,
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: callId,
      internal_chat_message_metadata_passthrough: { turn_id: DESKTOP_TURN_ID },
      input: `const result = await tools.exec_command({
  cmd: "ls -la",
  sandbox_permissions: "require_escalated",
  justification: "May I list the workspace files?"
});
text(result);`,
    },
  };
}

async function bridgeHarness(t, options = {}) {
  const codex = new FakeCodex();
  const devices = new FakeDevices();
  const voice = options.voice || new FakeVoice();
  const connection = options.connection || new FakeConnection();
  const logs = [];
  const bridge = new CodexBuddyBridge({
    ...options,
    codex,
    devices,
    voice,
    log: options.log || ((line) => logs.push(line)),
    pollMs: 60_000,
    heartbeatMs: 60_000,
  });
  t.after(() => bridge.stop());
  await bridge.start();
  devices.emit("authenticated", connection);
  return { bridge, codex, devices, voice, connection, logs };
}

function voiceStart(overrides = {}) {
  return {
    cmd: "voice",
    action: "start",
    session: VOICE_SESSION,
    sampleRate: 24_000,
    channels: 1,
    format: "pcm_s16le",
    ...overrides,
  };
}

function voiceAudio(seq, pcm, overrides = {}) {
  return {
    cmd: "voice_audio",
    session: VOICE_SESSION,
    seq,
    encoding: "base64",
    data: Buffer.from(pcm).toString("base64"),
    ...overrides,
  };
}

function voiceStop(seq, samples, overrides = {}) {
  return {
    cmd: "voice",
    action: "stop",
    session: VOICE_SESSION,
    seq,
    samples,
    ...overrides,
  };
}

function voiceDatagram(seq, pcm, overrides = {}) {
  return {
    session: VOICE_SESSION,
    seq,
    pcm: Buffer.from(pcm),
    ...overrides,
  };
}

function pcm16Samples(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));
  return pcm;
}

function readPcm16Samples(pcm) {
  const samples = [];
  for (let offset = 0; offset < pcm.length; offset += 2) {
    samples.push(pcm.readInt16LE(offset));
  }
  return samples;
}

class FakeCodex extends EventEmitter {
  constructor() {
    super();
    this.responses = [];
  }
  start() {}
  stop() {}
  async initialize() {
    return { userAgent: "fake-codex" };
  }
  async request(method) {
    if (method === "thread/list") return { data: [] };
    throw new Error(`unexpected request ${method}`);
  }
  respond(id, result) {
    this.responses.push({ id, result });
  }
}

class FakeDevices extends EventEmitter {
  constructor() {
    super();
    this.host = "127.0.0.1";
    this.port = 0;
    this.connectedCount = 1;
    this.broadcasts = [];
  }
  async start() {}
  stop() {}
  broadcast(payload) {
    this.broadcasts.push(payload);
  }
}

class FakeDesktopSession extends EventEmitter {
  async start() {}
  stop() {}
}

class FakeVoice {
  constructor(options = {}) {
    this.calls = [];
    this.error = options.error || null;
  }

  beginPcmAudio(options) {
    const owner = this;
    const call = {
      options: { ...options },
      appends: [],
      finishCalls: 0,
      abortCalls: 0,
      done: false,
      emitDelta(delta, event = {}) {
        options.onDelta?.(delta, event);
      },
    };
    this.calls.push(call);
    return {
      appendBase64(audio) {
        if (call.done) throw new Error("fake voice stream is closed");
        call.appends.push(audio);
      },
      async finish() {
        call.finishCalls += 1;
        if (owner.error) throw owner.error;
        options.onFinalTranscript?.("speak status", {
          threadId: "thread-1",
          submitted: options.submit !== false,
        });
        call.done = true;
        return {
          threadId: "thread-1",
          transcript: "speak status",
          submitted: options.submit !== false,
        };
      },
      abort() {
        if (call.done) return;
        call.done = true;
        call.abortCalls += 1;
      },
    };
  }
}

class DeferredSubmissionVoice {
  constructor() {
    this.calls = [];
    this.submission = new Promise((resolve, reject) => {
      this.resolveSubmission = resolve;
      this.rejectSubmission = reject;
    });
  }

  beginPcmAudio(options) {
    const owner = this;
    const call = { appends: [], abortCalls: 0 };
    this.calls.push(call);
    return {
      appendBase64(audio) {
        call.appends.push(audio);
      },
      async finish() {
        options.onFinalTranscript?.("authoritative final transcript", {
          threadId: "thread-1",
          submitted: true,
        });
        return owner.submission;
      },
      abort() {
        call.abortCalls += 1;
      },
    };
  }

  completeSubmission() {
    this.resolveSubmission({
      threadId: "thread-1",
      transcript: "authoritative final transcript",
      submitted: true,
      turnId: "turn-1",
      turnStatus: "inProgress",
    });
  }

  failSubmission(error) {
    this.rejectSubmission(error);
  }

  stop() {}
}

class FakeConnection {
  constructor(options = {}) {
    this.name = "test-stick";
    this.authenticated = options.authenticated ?? true;
    this.remoteAddress = options.remoteAddress || "192.0.2.10";
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
  }
  send(payload) {
    this.sent.push(payload);
  }
  close() {
    this.closeCalls += 1;
  }
  terminate() {
    this.terminateCalls += 1;
  }
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
