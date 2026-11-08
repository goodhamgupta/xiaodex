import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VoiceController } from "../src/mac/voice.mjs";

test("streams M5 PCM to Realtime before release and submits the final transcript", async () => {
  const codex = new FakeCodex();
  const realtime = new FakeRealtime({ transcript: "show repository status" });
  const voice = makeVoice({ codex, realtime });
  const finalTranscripts = [];

  const stream = voice.beginPcmAudio({
    sampleRate: 24_000,
    numChannels: 1,
    onFinalTranscript: (transcript, metadata) => {
      finalTranscripts.push({ transcript, metadata });
      assert.equal(
        codex.calls.some((call) => call.method === "turn/start"),
        false,
      );
    },
  });
  stream.appendBase64(Buffer.from([1, 0, 2, 0]).toString("base64"), 4);
  stream.appendPcm(Buffer.from([3, 0, 4, 0]));

  assert.deepEqual(
    realtime.sessions[0].appends.map((value) => Buffer.from(value, "base64")),
    [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0])],
  );
  assert.equal(realtime.sessions[0].finishCalls, 0);

  const result = await stream.finish();
  assert.deepEqual(result, {
    threadId: "thread-1",
    transcript: "show repository status",
    submitted: true,
    turnId: "turn-1",
    turnStatus: "inProgress",
  });
  assert.equal(realtime.sessions[0].finishCalls, 1);
  assert.deepEqual(finalTranscripts, [{
    transcript: "show repository status",
    metadata: { submitted: true },
  }]);
  assert.equal(realtime.options[0].model, "gpt-live-transcribe");
  assert.equal(realtime.options[0].sampleRate, 24_000);
  assert.equal(realtime.options[0].language, "en");
  assert.equal(realtime.options[0].delay, "low");

  assert.equal(codex.calls[0].method, "thread/list");
  assert.equal(codex.calls[0].params.cwd, process.cwd());
  assert.equal(codex.calls[0].params.sortKey, "updated_at");
  assert.equal(codex.calls[1].method, "thread/resume");
  assert.equal(codex.calls[1].params.threadId, "thread-1");
  assert.equal(codex.calls[2].method, "turn/start");
  assert.equal(codex.calls[2].params.input[0].text, "show repository status");
  assert.equal(codex.calls[2].params.approvalPolicy, "on-request");
  assert.equal(codex.calls[2].params.approvalsReviewer, "user");
  assert.equal(JSON.stringify(codex.calls).includes("host-secret"), false);
});

test("forwards live transcript deltas while recording and detaches on abort", () => {
  const realtime = new FakeRealtime();
  const voice = makeVoice({ realtime });
  const deltas = [];
  const stream = voice.beginPcmAudio({
    onDelta: (delta, event) => deltas.push({ delta, event }),
  });

  realtime.sessions[0].emitDelta("hello", { type: "delta" });
  assert.deepEqual(deltas, [{ delta: "hello", event: { type: "delta" } }]);
  stream.abort();
  realtime.sessions[0].emitDelta(" ignored");
  assert.equal(deltas.length, 1);
});

test("surfaces the final transcript before a slow Codex target resolves", async () => {
  const codex = new DeferredTargetCodex();
  const realtime = new FakeRealtime({ transcript: "visible immediately" });
  const voice = makeVoice({ codex, realtime, threadId: "thread-slow" });
  const finalTranscripts = [];
  const stream = voice.beginPcmAudio({
    onFinalTranscript: (transcript, metadata) => {
      finalTranscripts.push({ transcript, metadata });
    },
  });
  stream.appendPcm(Buffer.from([1, 0]));
  const finishing = stream.finish();

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finalTranscripts, [{
    transcript: "visible immediately",
    metadata: { submitted: true },
  }]);
  assert.equal(codex.calls.some((call) => call.method === "turn/start"), false);

  codex.resolveTarget({ thread: { id: "thread-slow" } });
  assert.equal((await finishing).transcript, "visible immediately");
});

test("can prewarm Realtime and replenishes the idle session after a turn", async () => {
  const realtime = new FakeRealtime({ transcript: "warm result" });
  const voice = new VoiceController({
    codex: new FakeCodex(),
    openaiApiKey: "host-secret",
    prewarm: true,
    realtimeSessionFactory: (options) => realtime.create(options),
  });

  assert.equal(realtime.sessions.length, 1);
  const warmed = realtime.sessions[0];
  const stream = voice.beginPcmAudio();
  assert.strictEqual(realtime.sessions[0], warmed);
  assert.equal(realtime.sessions.length, 1);
  stream.appendPcm(Buffer.from([1, 0]));
  assert.equal((await stream.finish()).transcript, "warm result");
  assert.equal(realtime.sessions.length, 2);

  voice.stop();
  assert.equal(realtime.sessions[1].abortCalls, 1);
});

test("navigation taps reuse an unused connection but recorded audio never carries over", async (t) => {
  const realtime = new FakeRealtime();
  const codex = new FakeCodex();
  const voice = new VoiceController({ codex, openaiApiKey: "host-secret", prewarm: true,
    realtimeSessionFactory: o => realtime.create(o) });
  t.after(() => voice.stop());
  for (let i = 0; i < 5; i++) voice.beginPcmAudio().abort();
  assert.equal(realtime.sessions.length, 1);
  assert.equal(realtime.sessions[0].abortCalls, 0);
  assert.equal(codex.calls.some(c => c.method === "turn/start"), false);
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.from([1, 0]));
  stream.abort();
  assert.equal(realtime.sessions[0].abortCalls, 1);
  assert.equal(realtime.sessions.length, 2);
  assert.deepEqual(realtime.sessions[1].appends, []);
});

test("idle prewarm recovers after failure without a button press and stops cleanly", async (t) => {
  const realtime = new FakeRealtime();
  const voice = new VoiceController({ codex: new FakeCodex(), openaiApiKey: "host-secret",
    prewarm: true, prewarmRefreshMs: 10, realtimeSessionFactory: o => realtime.create(o) });
  t.after(() => voice.stop());
  realtime.sessions[0].abort();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(realtime.sessions.length, 2);
  const stream = voice.beginPcmAudio();
  realtime.sessions[1].abort();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(realtime.sessions.length, 2, "do not replace an active recording");
  stream.abort();
  assert.equal(realtime.sessions.length, 3);
  voice.stop();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(realtime.sessions.length, 3);
});

test("stop during finishing cannot replenish prewarm or allow another recording", async () => {
  const realtime = new DeferredRealtime();
  const voice = new VoiceController({
    codex: new FakeCodex(),
    openaiApiKey: "host-secret",
    prewarm: true,
    realtimeSessionFactory: (options) => realtime.create(options),
  });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.from([1, 0]));
  const finishing = stream.finish();

  voice.stop();

  await assert.rejects(finishing, /aborted/);
  assert.equal(realtime.sessions.length, 1);
  assert.equal(realtime.sessions[0].abortCalls, 1);
  assert.throws(() => voice.beginPcmAudio(), /controller is stopped/);
});

test("accepts a validated 24 kHz PCM16 mono WAV and can skip Codex submission", async () => {
  const codex = new FakeCodex();
  const realtime = new FakeRealtime({ transcript: "do not submit this" });
  const pcm = Buffer.from([10, 0, 20, 0]);
  const original = makePcm16Wav(pcm, 24_000);
  const voice = makeVoice({ codex, realtime });

  const result = await voice.submitAudio({
    audio: original,
    format: "wav",
    sampleRate: 24_000,
    numChannels: 1,
    submit: false,
  });

  assert.deepEqual(
    Buffer.concat(realtime.sessions[0].appends.map((value) => Buffer.from(value, "base64"))),
    pcm,
  );
  assert.deepEqual(result, {
    threadId: "thread-1",
    transcript: "do not submit this",
    submitted: false,
  });
  assert.equal(codex.calls.some((call) => call.method === "turn/start"), false);
});

test("requires a bridge-hosted OpenAI API key", () => {
  const voice = new VoiceController({
    codex: new FakeCodex(),
    openaiApiKey: "",
    realtimeSessionFactory: () => assert.fail("Realtime must not start without a host API key"),
  });

  assert.throws(
    () => voice.beginPcmAudio({ sampleRate: 24_000 }),
    /requires OPENAI_API_KEY in the Mac bridge environment/,
  );
});

test("supports only the OpenAI provider for onboard microphone audio", () => {
  assert.throws(
    () => new VoiceController({
      codex: new FakeCodex(),
      provider: "codex-realtime",
      openaiApiKey: "host-secret",
    }),
    /supports only the OpenAI provider/,
  );

  const auto = new VoiceController({
    codex: new FakeCodex(),
    provider: "auto",
    openaiApiKey: "host-secret",
  });
  assert.equal(auto.provider, "openai");
});

test("validates PCM framing, 24 kHz mono input, and duration", async () => {
  const realtime = new FakeRealtime();
  const voice = makeVoice({ realtime });

  assert.throws(
    () => voice.beginPcmAudio({ sampleRate: 16_000 }),
    /requires 24000 Hz mono PCM/,
  );
  assert.throws(
    () => voice.beginPcmAudio({ sampleRate: 24_000, numChannels: 2 }),
    /must be mono/,
  );

  await assert.rejects(
    () => voice.submitPcmAudio({ pcm: Buffer.from([1]), sampleRate: 24_000 }),
    /complete samples/,
  );
  await assert.rejects(
    () => voice.submitPcmAudio({
      pcm: Buffer.alloc(24_000 * 2 * 30 + 2),
      sampleRate: 24_000,
    }),
    /30-second limit/,
  );

  const stream = voice.beginPcmAudio({ sampleRate: 24_000 });
  assert.throws(() => stream.appendBase64("not base64"), /invalid base64/);
  stream.abort();
});

test("validates WAV structure and bridge metadata", async () => {
  const voice = makeVoice();

  await assert.rejects(
    () => voice.submitAudio({ audio: Buffer.from("not a wav"), format: "wav" }),
    /invalid header/,
  );
  await assert.rejects(
    () => voice.submitAudio({
      audio: makePcm16Wav(Buffer.from([1, 0]), 24_000),
      format: "wav",
      sampleRate: 16_000,
    }),
    /sample rate does not match/,
  );
});

test("uses only validated host-owned thread targets", async () => {
  const codex = new FakeCodex();
  const realtime = new FakeRealtime({ transcript: "trusted target" });
  const voice = makeVoice({ codex, realtime, threadId: "thread-host" });

  const result = await voice.submitPcmAudio({
    pcm: Buffer.from([1, 0]),
    sampleRate: 24_000,
    threadId: "thread-host-override",
  });

  assert.equal(result.threadId, "thread-host-override");
  assert.equal(codex.calls.some((call) => call.method === "thread/list"), false);
  assert.equal(codex.calls[0].method, "thread/resume");
  assert.equal(codex.calls[0].params.threadId, "thread-host-override");
  assert.equal(codex.calls.at(-1).params.threadId, "thread-host-override");
  await assert.rejects(
    () => voice.submitPcmAudio({
      pcm: Buffer.from([1, 0]),
      sampleRate: 24_000,
      threadId: "untrusted thread\nvalue",
    }),
    /threadId contains invalid characters/,
  );
});

test("resolves the latest host task once for each recording", async () => {
  const codex = new FakeCodex();
  const realtime = new FakeRealtime({ transcript: "follow the active task" });
  const targets = ["thread-first", "thread-second"];
  let resolutions = 0;
  const voice = makeVoice({
    codex,
    realtime,
    resolveThreadId: async () => targets[resolutions++],
  });

  const first = await voice.submitPcmAudio({
    pcm: Buffer.from([1, 0]),
    sampleRate: 24_000,
  });
  const second = await voice.submitPcmAudio({
    pcm: Buffer.from([2, 0]),
    sampleRate: 24_000,
  });

  assert.equal(first.threadId, "thread-first");
  assert.equal(second.threadId, "thread-second");
  assert.equal(resolutions, 2);
  assert.deepEqual(
    codex.calls
      .filter((call) => call.method === "thread/resume")
      .map((call) => call.params.threadId),
    targets,
  );
  assert.deepEqual(
    codex.calls
      .filter((call) => call.method === "turn/start")
      .map((call) => call.params.threadId),
    targets,
  );
  assert.equal(codex.calls.some((call) => call.method === "thread/list"), false);
});

test("an explicit host task remains pinned when a latest-task resolver exists", async () => {
  let resolutions = 0;
  const voice = makeVoice({
    threadId: "thread-pinned",
    resolveThreadId: async () => {
      resolutions += 1;
      return "thread-latest";
    },
  });

  const result = await voice.submitPcmAudio({
    pcm: Buffer.from([1, 0]),
    sampleRate: 24_000,
  });

  assert.equal(result.threadId, "thread-pinned");
  assert.equal(resolutions, 0);
});

test("a latest-task resolver overrides an environment-only pinned target", async (t) => {
  const previous = process.env.CODEX_BUDDY_VOICE_THREAD_ID;
  process.env.CODEX_BUDDY_VOICE_THREAD_ID = "thread-from-environment";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BUDDY_VOICE_THREAD_ID;
    else process.env.CODEX_BUDDY_VOICE_THREAD_ID = previous;
  });

  const voice = makeVoice({ resolveThreadId: async () => "thread-latest" });
  const result = await voice.submitPcmAudio({
    pcm: Buffer.from([1, 0]),
    sampleRate: 24_000,
  });

  assert.equal(result.threadId, "thread-latest");
});

test("fails closed when the latest-task resolver returns no task", async () => {
  const codex = new FakeCodex();
  const targets = ["", "thread-recovered"];
  let resolutions = 0;
  const voice = makeVoice({
    codex,
    resolveThreadId: async () => targets[resolutions++],
  });

  await assert.rejects(
    () => voice.submitPcmAudio({
      pcm: Buffer.from([1, 0]),
      sampleRate: 24_000,
    }),
    /did not return a task id/,
  );
  assert.equal(
    codex.calls.some((call) => ["thread/list", "thread/start", "turn/start"].includes(call.method)),
    false,
  );

  const recovered = await voice.submitPcmAudio({
    pcm: Buffer.from([2, 0]),
    sampleRate: 24_000,
  });
  assert.equal(recovered.threadId, "thread-recovered");
  assert.equal(resolutions, 2);
});

test("keeps one latest-task resolution through an empty-transcript retry", async () => {
  const realtime = new FakeRealtime({
    outcomes: [
      { error: noSpeechError() },
      { transcript: "recovered transcript" },
    ],
  });
  let resolutions = 0;
  const voice = makeVoice({
    realtime,
    resolveThreadId: async () => {
      resolutions += 1;
      return "thread-retry";
    },
  });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.alloc(24_000));

  const result = await stream.finish();

  assert.equal(result.threadId, "thread-retry");
  assert.equal(result.transcript, "recovered transcript");
  assert.equal(resolutions, 1);
});

test("compatibility capture entry point still requires audio from the M5", async () => {
  const realtime = new FakeRealtime({ transcript: "from device" });
  const voice = makeVoice({ realtime });

  await assert.rejects(
    () => voice.captureAndSubmit({ durationSeconds: 6 }),
    /requires PCM or WAV audio from the M5StickC Plus/,
  );
  const result = await voice.captureAndSubmit({
    pcm: Buffer.from([1, 0]),
    sampleRate: 24_000,
    submit: false,
  });
  assert.equal(result.transcript, "from device");
  assert.equal(result.submitted, false);
});

test("rejects concurrent streams and abort releases the controller", () => {
  const realtime = new FakeRealtime();
  const voice = makeVoice({ realtime });

  const first = voice.beginPcmAudio();
  assert.throws(() => voice.beginPcmAudio(), /already in progress/);
  first.abort();

  const second = voice.beginPcmAudio();
  second.abort();
  assert.equal(realtime.sessions[0].abortCalls, 1);
  assert.equal(realtime.sessions[1].abortCalls, 1);
});

test("an aborted finishing stream cannot release its replacement", async () => {
  const realtime = new DeferredRealtime();
  const voice = makeVoice({ realtime });
  const first = voice.beginPcmAudio();
  first.appendPcm(Buffer.from([1, 0]));
  const firstFinish = first.finish();

  first.abort();
  const second = voice.beginPcmAudio();
  await assert.rejects(firstFinish, /aborted/);
  assert.throws(() => voice.beginPcmAudio(), /already in progress/);
  second.abort();
});

test("propagates Realtime failures and releases the controller", async () => {
  const realtime = new FakeRealtime({ error: new Error("OpenAI realtime unavailable") });
  const voice = makeVoice({ realtime });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.from([1, 0]));

  await assert.rejects(() => stream.finish(), /realtime unavailable/);
  assert.equal(realtime.sessions.length, 1);
  const next = voice.beginPcmAudio();
  next.abort();
});

test("recovers one empty transcript across sequential turns and submits each turn once", async () => {
  const noSpeech = new Error("detected no speech");
  noSpeech.code = "NO_SPEECH";
  const realtime = new FakeRealtime({
    outcomes: [
      { transcript: "first turn" },
      { transcript: "second turn" },
      { error: noSpeech },
      { transcript: "recovered third turn", delta: "recovered " },
      { transcript: "fourth turn" },
    ],
  });
  const codex = new FakeCodex();
  const voice = makeVoice({ codex, realtime });
  const transcripts = [];
  const retryDeltas = [];
  const turnAudio = [];

  for (let turn = 0; turn < 4; turn += 1) {
    const pcm = Buffer.alloc(24_000, turn + 1);
    turnAudio.push(pcm);
    const stream = voice.beginPcmAudio({
      onDelta: turn === 2 ? (delta) => retryDeltas.push(delta) : undefined,
    });
    stream.appendPcm(pcm);
    transcripts.push((await stream.finish()).transcript);
  }

  assert.deepEqual(transcripts, [
    "first turn",
    "second turn",
    "recovered third turn",
    "fourth turn",
  ]);
  assert.equal(realtime.sessions.length, 5);
  assert.deepEqual(
    realtime.options.map((options) => options.delay),
    ["low", "low", "low", "medium", "low"],
  );
  assert.equal(realtime.sessions[2].abortCalls, 1);
  assert.deepEqual(retryDeltas, ["recovered "]);
  assert.deepEqual(
    realtime.sessions[3].appends.map((audio) => Buffer.from(audio, "base64")),
    [turnAudio[2]],
  );
  assert.deepEqual(
    realtime.sessions[4].appends.map((audio) => Buffer.from(audio, "base64")),
    [turnAudio[3]],
  );
  assert.deepEqual(
    codex.calls
      .filter((call) => call.method === "turn/start")
      .map((call) => call.params.input[0].text),
    ["first turn", "second turn", "recovered third turn", "fourth turn"],
  );
});

test("does not retry an empty transcript when captured audio is shorter than 500ms", async () => {
  const noSpeech = new Error("detected no speech");
  noSpeech.code = "NO_SPEECH";
  const realtime = new FakeRealtime({ error: noSpeech });
  const codex = new FakeCodex();
  const voice = makeVoice({ codex, realtime });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.alloc(23_952));

  await assert.rejects(() => stream.finish(), (error) => error.code === "NO_SPEECH");
  assert.equal(realtime.sessions.length, 1);
  assert.equal(codex.calls.some((call) => call.method === "turn/start"), false);
});

test("a second empty result releases ownership and allows the next turn", async () => {
  const firstNoSpeech = noSpeechError();
  const secondNoSpeech = noSpeechError();
  const realtime = new FakeRealtime({
    outcomes: [
      { error: firstNoSpeech },
      { error: secondNoSpeech },
      { transcript: "next turn works" },
    ],
  });
  const codex = new FakeCodex();
  const voice = makeVoice({ codex, realtime });
  const failed = voice.beginPcmAudio();
  failed.appendPcm(Buffer.alloc(24_000));

  await assert.rejects(() => failed.finish(), (error) => error.code === "NO_SPEECH");

  const next = voice.beginPcmAudio();
  next.appendPcm(Buffer.alloc(24_000));
  assert.equal((await next.finish()).transcript, "next turn works");
  assert.equal(realtime.sessions.length, 3);
  assert.equal(
    codex.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
});

test("an explicit high delay is not downgraded by empty-transcript recovery", async () => {
  const realtime = new FakeRealtime({
    outcomes: [
      { error: noSpeechError() },
      { transcript: "high context recovery" },
    ],
  });
  const voice = makeVoice({ realtime, delay: "high" });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.alloc(24_000));

  assert.equal((await stream.finish()).transcript, "high context recovery");
  assert.deepEqual(
    realtime.options.map((options) => options.delay),
    ["high", "high"],
  );
});

test("a target failure prevents a late no-speech error from starting an orphan retry", async () => {
  const codex = new DeferredTargetCodex();
  const realtime = new LateFailureRealtime();
  const voice = makeVoice({ codex, realtime, threadId: "thread-race" });
  const stream = voice.beginPcmAudio();
  stream.appendPcm(Buffer.alloc(24_000));
  const finishing = stream.finish();

  codex.rejectTarget(new Error("target thread unavailable"));
  await assert.rejects(finishing, /target thread unavailable/);
  realtime.rejectFinish(noSpeechError());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(realtime.sessions.length, 1);
  assert.equal(realtime.sessions[0].abortCalls, 1);
});

test("retry construction and replay failures both release the controller", async (t) => {
  await t.test("constructor failure", async () => {
    const realtime = new FakeRealtime({
      outcomes: [
        { error: noSpeechError() },
        { transcript: "next after constructor failure" },
      ],
    });
    let createCalls = 0;
    const voice = new VoiceController({
      codex: new FakeCodex(),
      openaiApiKey: "host-secret",
      realtimeSessionFactory: (options) => {
        createCalls += 1;
        if (createCalls === 2) throw new Error("retry constructor failed");
        return realtime.create(options);
      },
    });
    const failed = voice.beginPcmAudio();
    failed.appendPcm(Buffer.alloc(24_000));
    await assert.rejects(() => failed.finish(), /retry constructor failed/);

    const next = voice.beginPcmAudio();
    next.appendPcm(Buffer.alloc(24_000));
    assert.equal((await next.finish()).transcript, "next after constructor failure");
  });

  await t.test("replay append failure", async () => {
    const realtime = new FakeRealtime({
      outcomes: [
        { error: noSpeechError() },
        { appendError: new Error("retry append failed") },
        { transcript: "next after append failure" },
      ],
    });
    const voice = makeVoice({ realtime });
    const failed = voice.beginPcmAudio();
    failed.appendPcm(Buffer.alloc(24_000));
    await assert.rejects(() => failed.finish(), /retry append failed/);

    const next = voice.beginPcmAudio();
    next.appendPcm(Buffer.alloc(24_000));
    assert.equal((await next.finish()).transcript, "next after append failure");
  });
});

test("replays a timed-out or disconnected transcription once and submits only once", async () => {
  for (const code of ["TRANSCRIPTION_TIMEOUT", "REALTIME_CONNECTION_LOST"]) {
    const error = Object.assign(new Error("connection stalled"), { code, transcriptStarted: false });
    const realtime = new FakeRealtime({ outcomes: [{ error }, { transcript: "complete recovered text" }] });
    const codex = new FakeCodex();
    const voice = makeVoice({ realtime, codex });
    const stream = voice.beginPcmAudio();
    stream.appendPcm(Buffer.alloc(24_000));
    assert.equal((await stream.finish()).transcript, "complete recovered text");
    assert.deepEqual(realtime.sessions[1].appends, realtime.sessions[0].appends);
    assert.equal(realtime.sessions[0].abortCalls, 1);
    assert.equal(realtime.options[1].delay, "low");
    assert.equal(codex.calls.filter(c => c.method === "turn/start").length, 1);
    voice.stop();
  }
});

test("connection recovery is bounded and never replays a visible partial transcript", async () => {
  for (const transcriptStarted of [false, true]) {
    const error = Object.assign(new Error("connection stalled"), {
      code: "TRANSCRIPTION_TIMEOUT", transcriptStarted,
    });
    const realtime = new FakeRealtime({ error });
    const codex = new FakeCodex();
    const voice = makeVoice({ realtime, codex });
    const stream = voice.beginPcmAudio();
    stream.appendPcm(Buffer.alloc(24_000));
    await assert.rejects(stream.finish(), /connection stalled/);
    assert.equal(realtime.sessions.length, transcriptStarted ? 1 : 2);
    assert.equal(codex.calls.filter(c => c.method === "turn/start").length, 0);
    voice.stop();
  }
});

function makeVoice(options = {}) {
  const realtime = options.realtime || new FakeRealtime();
  return new VoiceController({
    codex: options.codex || new FakeCodex(),
    openaiApiKey: "host-secret",
    threadId: options.threadId,
    resolveThreadId: options.resolveThreadId,
    language: options.language,
    delay: options.delay,
    realtimeSessionFactory: (sessionOptions) => realtime.create(sessionOptions),
  });
}

class FakeRealtime {
  constructor(options = {}) {
    this.transcript = options.transcript || "fake transcript";
    this.error = options.error || null;
    this.outcomes = options.outcomes || null;
    this.options = [];
    this.sessions = [];
  }

  create(options) {
    this.options.push(options);
    const parent = this;
    const outcome = this.outcomes?.[this.sessions.length];
    const events = new EventEmitter();
    const session = {
      appends: [],
      finishCalls: 0,
      abortCalls: 0,
      done: false,
      get isUsable() { return !this.done; },
      on: events.on.bind(events),
      off: events.off.bind(events),
      emitDelta(delta, event = {}) {
        events.emit("delta", delta, event);
      },
      appendBase64(value) {
        if (this.done) throw new Error("fake session is closed");
        if (outcome?.appendError) throw outcome.appendError;
        this.appends.push(value);
      },
      async finish() {
        this.finishCalls += 1;
        if (outcome?.error || parent.error) throw outcome?.error || parent.error;
        if (outcome?.delta) events.emit("delta", outcome.delta, { type: "delta" });
        this.done = true;
        return outcome?.transcript || parent.transcript;
      },
      abort() {
        if (this.done) return;
        this.done = true;
        this.abortCalls += 1;
      },
    };
    this.sessions.push(session);
    return session;
  }
}

class DeferredRealtime extends FakeRealtime {
  create(options) {
    this.options.push(options);
    let rejectFinish;
    const session = {
      appends: [],
      finishCalls: 0,
      abortCalls: 0,
      done: false,
      appendBase64(value) {
        if (this.done) throw new Error("fake session is closed");
        this.appends.push(value);
      },
      finish() {
        this.finishCalls += 1;
        return new Promise((resolve, reject) => {
          rejectFinish = reject;
        });
      },
      abort() {
        if (this.done) return;
        this.done = true;
        this.abortCalls += 1;
        rejectFinish?.(new Error("realtime session aborted"));
      },
    };
    this.sessions.push(session);
    return session;
  }
}

class LateFailureRealtime extends FakeRealtime {
  create(options) {
    this.options.push(options);
    let rejectFinish;
    const session = {
      appends: [],
      abortCalls: 0,
      appendBase64(value) {
        this.appends.push(value);
      },
      finish() {
        return new Promise((_resolve, reject) => {
          rejectFinish = reject;
        });
      },
      abort() {
        this.abortCalls += 1;
      },
    };
    this.rejectFinish = (error) => rejectFinish(error);
    this.sessions.push(session);
    return session;
  }
}

class FakeCodex extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: [{ id: "thread-1", status: { type: "idle" } }] };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "thread/start") return { thread: { id: "thread-new" } };
    if (method === "turn/start") {
      return { turn: { id: "turn-1", status: { type: "inProgress" } } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

class DeferredTargetCodex extends FakeCodex {
  constructor() {
    super();
    this.targetPromise = new Promise((resolve, reject) => {
      this.resolveTarget = resolve;
      this.rejectTarget = reject;
    });
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "thread/resume") return this.targetPromise;
    if (method === "turn/start") {
      return { turn: { id: "turn-1", status: { type: "inProgress" } } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

function noSpeechError() {
  const error = new Error("detected no speech");
  error.code = "NO_SPEECH";
  return error;
}

function makePcm16Wav(pcm, sampleRate, numChannels = 1) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * 2, 28);
  header.writeUInt16LE(numChannels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
