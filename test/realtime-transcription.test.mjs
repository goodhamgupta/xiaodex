import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RealtimeTranscriptionSession } from "../src/mac/realtime-transcription.mjs";

const ITEM_ID = "item_001";

test("connects with server-side auth and sends config before queued audio in order", () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "host-secret",
    webSocketFactory: factory,
  });

  session.appendBase64("AQI=");
  session.appendBase64("AwQ=");
  assert.equal(factory.socket.sent.length, 0);

  factory.socket.open();
  assert.equal(
    factory.url,
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
  assert.deepEqual(factory.options, {
    headers: { Authorization: "Bearer host-secret" },
    handshakeTimeout: 10000,
  });
  assert.deepEqual(factory.socket.messages(), [{
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: {
            model: "gpt-live-transcribe",
            delay: "minimal",
            languages: ["en"],
          },
          turn_detection: null,
        },
      },
    },
  }]);

  factory.socket.serverEvent({
    type: "session.updated",
    session: { id: "sess_001", type: "transcription" },
  });
  assert.deepEqual(factory.socket.messages().slice(1), [
    { type: "input_audio_buffer.append", audio: "AQI=" },
    { type: "input_audio_buffer.append", audio: "AwQ=" },
  ]);
});

test("uses configured transcription fields and validates the realtime PCM contract", () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    model: "gpt-realtime-whisper",
    sampleRate: 24000,
    numChannels: 1,
    language: "zh",
    delay: "low",
    webSocketFactory: factory,
  });
  configure(factory);

  const update = factory.socket.messages()[0];
  assert.equal(update.session.audio.input.format.rate, 24000);
  assert.deepEqual(update.session.audio.input.transcription, {
    model: "gpt-realtime-whisper",
    language: "zh",
    delay: "low",
  });
  assert.throws(
    () => new RealtimeTranscriptionSession({
      apiKey: "secret",
      sampleRate: 16000,
      webSocketFactory: makeFactory(),
    }),
    /sampleRate must be 24000/,
  );
  assert.throws(
    () => new RealtimeTranscriptionSession({
      apiKey: "secret",
      numChannels: 2,
      webSocketFactory: makeFactory(),
    }),
    /must be mono/,
  );
});

test("finish after open sends one manual commit and resolves the final transcript", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  configure(factory);
  session.appendBase64("AQI=");

  const finished = session.finish();
  assert.strictEqual(session.finish(), finished);
  assert.deepEqual(factory.socket.messages().slice(-2), [
    { type: "input_audio_buffer.append", audio: "AQI=" },
    { type: "input_audio_buffer.commit" },
  ]);
  assert.equal(
    factory.socket.messages().filter((message) => (
      message.type === "input_audio_buffer.commit"
    )).length,
    1,
  );

  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "show repository status",
  });
  assert.equal(await finished, "show repository status");
  assert.equal(factory.socket.closeCalls, 1);
});

test("finish before open flushes config, audio, and commit in that order", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  session.appendBase64("AQI=");
  const finished = session.finish();

  factory.socket.open();
  assert.deepEqual(
    factory.socket.messages().map((message) => message.type),
    ["session.update"],
  );
  factory.socket.serverEvent({
    type: "session.updated",
    session: { type: "transcription" },
  });
  assert.deepEqual(
    factory.socket.messages().map((message) => message.type),
    [
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
    ],
  );
  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "queued request",
  });
  assert.equal(await finished, "queued request");
});

test("emits transcript deltas without resolving before completion", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  const deltas = [];
  session.on("delta", (delta, event) => deltas.push({ delta, type: event.type }));
  configure(factory);
  const finished = session.finish();

  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "hello",
  });
  assert.deepEqual(deltas, [{
    delta: "hello",
    type: "conversation.item.input_audio_transcription.delta",
  }]);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "hello world",
  });
  assert.equal(await finished, "hello world");
});

test("streams gpt-live-transcribe deltas before commit without replaying them", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  const deltas = [];
  session.on("delta", (delta) => deltas.push(delta));
  configure(factory);

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "live words",
  });
  assert.deepEqual(deltas, ["live words"]);

  const finished = session.finish();
  commit(factory);
  assert.deepEqual(deltas, ["live words"]);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "live words finalized",
  });
  assert.equal(await finished, "live words finalized");
});

test("rejects a committed item that differs from the streamed live item", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  configure(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "visible live text",
  });

  const finished = session.finish();
  factory.socket.serverEvent({
    type: "input_audio_buffer.committed",
    item_id: "item_different",
  });
  await assert.rejects(finished, /different live transcription item/);
});

test("uses streamed deltas when a short final commit has no completed text", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  configure(factory);
  const finished = session.finish();
  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "show ",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "status",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "   ",
  });

  assert.equal(await finished, "show status");
});

test("classifies an empty matching completion as no speech", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  configure(factory);
  const finished = session.finish();
  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "   ",
  });
  await assert.rejects(finished, (error) => {
    assert.match(error.message, /detected no speech/);
    assert.equal(error.code, "NO_SPEECH");
    return true;
  });
});

test("resolves only transcript events matching the committed item_id", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  const deltas = [];
  session.on("delta", (delta) => deltas.push(delta));
  configure(factory);
  const finished = session.finish();
  commit(factory);

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item_unrelated",
    delta: "wrong ",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item_unrelated",
    transcript: "wrong result",
  });
  assert.deepEqual(deltas, []);
  assert.equal(factory.socket.closeCalls, 0);

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "right ",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "right result",
  });
  assert.deepEqual(deltas, ["right "]);
  assert.equal(await finished, "right result");
});

test("buffers item events until input_audio_buffer.committed identifies the item", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    model: "gpt-realtime-whisper",
    webSocketFactory: factory,
  });
  const deltas = [];
  session.on("delta", (delta) => deltas.push(delta));
  configure(factory);
  const finished = session.finish();

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "early partial",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: ITEM_ID,
    transcript: "early final",
  });
  assert.deepEqual(deltas, []);
  assert.equal(factory.socket.closeCalls, 0);

  commit(factory);
  assert.deepEqual(deltas, ["early partial"]);
  assert.equal(await finished, "early final");
});

test("rejects a matching transcription.failed event and ignores other items", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  configure(factory);
  const finished = session.finish();
  commit(factory);

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "item_unrelated",
    error: {
      type: "transcription_error",
      code: "audio_unintelligible",
      message: "unrelated failure",
    },
  });
  assert.equal(factory.socket.closeCalls, 0);

  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.failed",
    event_id: "event_failed",
    item_id: ITEM_ID,
    error: {
      type: "transcription_error",
      code: "audio_unintelligible",
      message: "The audio could not be transcribed.",
    },
  });
  await assert.rejects(finished, /audio could not be transcribed/);
  assert.equal(factory.socket.closeCalls, 1);
});

test("emits metadata-only stage and timing diagnostics", async () => {
  const diagnostics = [];
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "diagnostic-secret-key",
    logger: (event) => diagnostics.push(event),
    webSocketFactory: factory,
  });
  const audio = Buffer.alloc(480, 7).toString("base64");
  configure(factory);
  session.appendBase64(audio);
  const finished = session.finish();
  commit(factory);
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: ITEM_ID,
    delta: "sensitive ",
  });
  factory.socket.serverEvent({
    type: "conversation.item.input_audio_transcription.completed",
    event_id: "event_completed",
    item_id: ITEM_ID,
    transcript: "sensitive transcript",
  });
  assert.equal(await finished, "sensitive transcript");

  assert.ok(diagnostics.every((event) => Number.isFinite(event.elapsedMs)));
  assert.ok(diagnostics.some((event) => event.event === "session.updated"));
  assert.deepEqual(
    diagnostics.find((event) => event.event === "input_audio_buffer.committed"),
    {
      event: "input_audio_buffer.committed",
      stage: "transcribing",
      elapsedMs: diagnostics.find(
        (event) => event.event === "input_audio_buffer.committed",
      ).elapsedMs,
      itemId: ITEM_ID,
      eventId: "event_committed",
      audioBytes: 480,
      audioChunks: 1,
      audioMs: 10,
      committedItemId: ITEM_ID,
    },
  );
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("diagnostic-secret-key"), false);
  assert.equal(serialized.includes(audio), false);
  assert.equal(serialized.includes("sensitive transcript"), false);
  assert.equal(serialized.includes("\"delta\":\"sensitive"), false);
});

test("rejects server and socket failures while redacting the API key", async (t) => {
  await t.test("server error", async () => {
    const factory = makeFactory();
    const session = new RealtimeTranscriptionSession({
      apiKey: "do-not-leak",
      webSocketFactory: factory,
    });
    factory.socket.open();
    const finished = session.finish();
    factory.socket.serverEvent({
      type: "error",
      error: { message: "credential do-not-leak rejected" },
    });

    await assert.rejects(finished, (error) => {
      assert.match(error.message, /credential \[REDACTED\] rejected/);
      assert.equal(error.message.includes("do-not-leak"), false);
      return true;
    });
  });

  await t.test("connection closes early", async () => {
    const factory = makeFactory();
    const session = new RealtimeTranscriptionSession({
      apiKey: "secret",
      webSocketFactory: factory,
    });
    factory.socket.open();
    const finished = session.finish();
    factory.socket.serverClose();
    await assert.rejects(finished, /closed before transcription completed/);
  });

  await t.test("failure before finish is retained safely", async () => {
    const factory = makeFactory();
    const session = new RealtimeTranscriptionSession({
      apiKey: "do-not-leak",
      webSocketFactory: factory,
    });
    factory.socket.serverError(new Error("socket exposed do-not-leak"));
    await assert.rejects(session.finish(), (error) => {
      assert.equal(error.message.includes("do-not-leak"), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  });
});

test("heartbeats retain a responsive idle socket and stop on abort", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({ apiKey: "secret",
    webSocketFactory: factory, heartbeatIntervalMs: 10, heartbeatTimeoutMs: 5 });
  configure(factory);
  t.mock.timers.tick(10);
  assert.equal(factory.socket.pings.length, 1);
  t.mock.timers.tick(6);
  assert.equal(session.isUsable, true);
  session.abort();
  t.mock.timers.tick(100);
  assert.equal(factory.socket.pings.length, 1);
});

test("a missing matching pong retires a half-open connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({ apiKey: "secret",
    webSocketFactory: factory, heartbeatIntervalMs: 10, heartbeatTimeoutMs: 5 });
  factory.socket.autoPong = false;
  configure(factory);
  t.mock.timers.tick(10);
  factory.socket.emit("pong", Buffer.from("unrelated"));
  t.mock.timers.tick(5);
  assert.equal(session.isUsable, false);
  assert.equal(factory.socket.terminateCalls, 1);
  await assert.rejects(session.finish(), { code: "REALTIME_CONNECTION_LOST", transcriptStarted: false });
});

test("connection setup has a deadline even before recording starts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({ apiKey: "secret",
    webSocketFactory: factory, connectionTimeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.equal(session.isUsable, false);
  assert.equal(factory.socket.terminateCalls, 1);
  await assert.rejects(session.finish(), { code: "REALTIME_CONNECTION_LOST" });
});

test("unused sessions expire but the idle deadline never interrupts recorded audio", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const idle = makeFactory();
  const unused = new RealtimeTranscriptionSession({ apiKey: "secret",
    webSocketFactory: idle, idleMaxAgeMs: 20 });
  configure(idle);
  const active = makeFactory();
  const recording = new RealtimeTranscriptionSession({ apiKey: "secret",
    webSocketFactory: active, idleMaxAgeMs: 20 });
  configure(active);
  recording.appendBase64("AQI=");
  t.mock.timers.tick(21);
  assert.equal(unused.isUsable, false);
  assert.equal(recording.isUsable, true);
  assert.equal(idle.socket.terminateCalls, 1);
  recording.abort();
});

test("async WebSocket write failures are surfaced and terminate the socket", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({ apiKey: "secret", webSocketFactory: factory });
  configure(factory);
  factory.socket.sendError = new Error("socket write failed");
  session.appendBase64("AQI=");
  await assert.rejects(session.finish(), { code: "REALTIME_CONNECTION_LOST" });
  assert.equal(factory.socket.terminateCalls, 1);
});

test("rejects finish on transcript timeout and closes the socket", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    transcriptTimeoutMs: 10,
    webSocketFactory: factory,
  });
  factory.socket.open();

  await assert.rejects(session.finish(), { code: "TRANSCRIPTION_TIMEOUT", transcriptStarted: false });
  assert.equal(factory.socket.closeCalls, 1);
});

test("abort is idempotent, closes once, and rejects an active finish", async () => {
  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  factory.socket.open();
  const finished = session.finish();

  session.abort();
  session.abort();
  assert.equal(factory.socket.closeCalls, 1);
  await assert.rejects(finished, /session was aborted/);
  assert.throws(() => session.appendBase64("AQI="), /after finish/);
});

test("validates credentials, WebSocket factory, and audio chunks without leaking keys", () => {
  assert.throws(() => new RealtimeTranscriptionSession(), /apiKey is required/);
  assert.throws(
    () => new RealtimeTranscriptionSession({
      apiKey: "secret",
      webSocketFactory: {},
    }),
    /webSocketFactory must be a function/,
  );
  assert.throws(
    () => new RealtimeTranscriptionSession({
      apiKey: "secret",
      logger: {},
    }),
    /logger must be a function/,
  );

  const factory = makeFactory();
  const session = new RealtimeTranscriptionSession({
    apiKey: "secret",
    webSocketFactory: factory,
  });
  assert.throws(() => session.appendBase64("not base64"), /valid base64/);

  assert.throws(
    () => new RealtimeTranscriptionSession({
      apiKey: "do-not-leak",
      webSocketFactory: () => {
        throw new Error("factory leaked do-not-leak");
      },
    }),
    (error) => {
      assert.equal(error.message.includes("do-not-leak"), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

function configure(factory) {
  factory.socket.open();
  factory.socket.serverEvent({
    type: "session.updated",
    event_id: "event_session_updated",
    session: { id: "sess_001", type: "transcription" },
  });
}

function commit(factory, itemId = ITEM_ID) {
  factory.socket.serverEvent({
    type: "input_audio_buffer.committed",
    event_id: "event_committed",
    previous_item_id: null,
    item_id: itemId,
  });
}

function makeFactory() {
  const factory = (url, options) => {
    factory.url = url;
    factory.options = options;
    factory.socket = new FakeWebSocket();
    return factory.socket;
  };
  return factory;
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.CLOSED = 3;
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    this.pings = [];
    this.autoPong = true;
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  send(data, callback) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    if (this.sendError) { callback?.(this.sendError); return; }
    this.sent.push(data);
  }

  ping(data) {
    this.pings.push(data);
    if (this.autoPong) this.emit("pong", Buffer.from(data));
  }

  terminate() {
    this.terminateCalls++;
    this.close();
  }

  close() {
    if (this.readyState === 3) return;
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close");
  }

  messages() {
    return this.sent.map((data) => JSON.parse(data));
  }

  serverEvent(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  serverError(error) {
    this.emit("error", error);
  }

  serverClose() {
    this.readyState = 3;
    this.emit("close");
  }
}
