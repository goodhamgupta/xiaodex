import { EventEmitter } from "node:events";
import WebSocket from "ws";

const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const DEFAULT_MODEL = "gpt-live-transcribe";
const REQUIRED_SAMPLE_RATE = 24000;
const REQUIRED_CHANNELS = 1;
const DEFAULT_LANGUAGE = "en";
const DEFAULT_DELAY = "minimal";
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 10000;
const OPEN = 1;

export class RealtimeTranscriptionSession extends EventEmitter {
  #apiKey;
  #socket;
  #queuedAudio = [];
  #opened = false;
  #configured = false;
  #finishRequested = false;
  #commitSent = false;
  #committedItemId;
  #liveItemId;
  #items = new Map();
  #settled = false;
  #aborted = false;
  #failure;
  #finishPromise;
  #resolveFinish;
  #rejectFinish;
  #timeout;
  #connectionTimer;
  #idleTimer;
  #heartbeatTimer;
  #pongTimer;
  #pingSequence = 0;
  #pendingPing;
  #logger;
  #startedAt = Date.now();
  #stage = "connecting";
  #audioBytes = 0;
  #audioChunks = 0;
  #firstDeltaSeen = false;

  constructor(options = {}) {
    super();

    this.#apiKey = requiredString(options.apiKey, "apiKey");
    this.model = optionalString(options.model, DEFAULT_MODEL, "model");
    this.sampleRate = validateSampleRate(options.sampleRate ?? REQUIRED_SAMPLE_RATE);
    this.numChannels = validateChannels(options.numChannels ?? REQUIRED_CHANNELS);
    this.language = optionalString(options.language, DEFAULT_LANGUAGE, "language");
    this.delay = optionalString(options.delay, DEFAULT_DELAY, "delay");
    this.transcriptTimeoutMs = positiveNumber(
      options.transcriptTimeoutMs,
      DEFAULT_TRANSCRIPT_TIMEOUT_MS,
      "transcriptTimeoutMs",
    );
    this.connectionTimeoutMs = positiveNumber(options.connectionTimeoutMs, 10000, "connectionTimeoutMs");
    this.idleMaxAgeMs = positiveNumber(options.idleMaxAgeMs, 300000, "idleMaxAgeMs");
    this.heartbeatIntervalMs = positiveNumber(options.heartbeatIntervalMs, 15000, "heartbeatIntervalMs");
    this.heartbeatTimeoutMs = positiveNumber(options.heartbeatTimeoutMs, 5000, "heartbeatTimeoutMs");
    if (options.logger !== undefined && typeof options.logger !== "function") {
      throw new TypeError("logger must be a function");
    }
    this.#logger = options.logger;

    const webSocketFactory = options.webSocketFactory || defaultWebSocketFactory;
    if (typeof webSocketFactory !== "function") {
      throw new TypeError("webSocketFactory must be a function");
    }

    this.#diagnose("socket.connecting");
    try {
      this.#socket = webSocketFactory(REALTIME_URL, {
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        handshakeTimeout: this.connectionTimeoutMs,
      });
    } catch (error) {
      this.#diagnose("socket.connection_failed");
      throw this.#error("connection failed", error);
    }
    if (!this.#socket || typeof this.#socket.on !== "function") {
      throw new TypeError("webSocketFactory must return an EventEmitter-compatible WebSocket");
    }

    this.#socket.on("open", () => this.#onOpen());
    this.#socket.on("message", (data) => this.#onMessage(data));
    this.#socket.on("error", (error) => this.#fail("connection error", error, true, "REALTIME_CONNECTION_LOST"));
    this.#socket.on("close", () => this.#onClose());
    this.#socket.on("pong", (data) => {
      if (this.#pendingPing === undefined || String(data) !== this.#pendingPing) return;
      if (this.#pingSequence === 1) this.#diagnose("socket.heartbeat_verified");
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
      this.#pendingPing = undefined;
    });
    this.#connectionTimer = setTimeout(() => {
      this.#fail("connection setup timed out", undefined, true, "REALTIME_CONNECTION_LOST");
    }, this.connectionTimeoutMs);
    this.#connectionTimer.unref?.();
    this.#idleTimer = setTimeout(() => {
      if (this.#audioBytes === 0) this.#fail("idle connection expired", undefined, true, "IDLE_EXPIRED");
    }, this.idleMaxAgeMs);
    this.#idleTimer.unref?.();
  }

  appendBase64(audio) {
    if (this.#finishRequested) {
      throw new Error("cannot append realtime transcription audio after finish");
    }
    if (this.#aborted) throw new Error("realtime transcription session was aborted");
    if (this.#failure) throw this.#failure;

    const encoded = validateBase64(audio);
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const bytes = base64DecodedLength(encoded);
    this.#audioBytes += bytes;
    this.#audioChunks += 1;
    if (this.#audioChunks === 1) {
      this.#diagnose("audio.first_append", {
        chunkBytes: bytes,
        audioBytes: this.#audioBytes,
        audioMs: this.#audioDurationMs(),
      });
    }
    if (!this.#configured) {
      this.#queuedAudio.push(encoded);
      return;
    }
    this.#send({ type: "input_audio_buffer.append", audio: encoded });
  }

  get isUsable() {
    return !this.#finishRequested &&
      !this.#settled &&
      !this.#aborted &&
      !this.#failure &&
      // Also check the clock synchronously after Mac sleep, before timers run.
      (this.#audioBytes > 0 || Date.now() - this.#startedAt < this.idleMaxAgeMs);
  }

  get isOpen() {
    return this.#configured && this.isUsable;
  }

  finish() {
    if (this.#finishPromise) return this.#finishPromise;

    this.#finishRequested = true;
    this.#finishPromise = new Promise((resolve, reject) => {
      this.#resolveFinish = resolve;
      this.#rejectFinish = reject;
    });

    if (this.#failure) {
      this.#reject(this.#failure);
      return this.#finishPromise;
    }
    if (this.#aborted) {
      this.#reject(this.#error("session was aborted"));
      return this.#finishPromise;
    }

    this.#timeout = setTimeout(() => {
      this.#diagnose("transcript.timeout", this.#audioDiagnostic());
      this.#fail("transcript timed out", undefined, true, "TRANSCRIPTION_TIMEOUT");
    }, this.transcriptTimeoutMs);
    this.#timeout.unref?.();

    if (this.#configured) {
      this.#sendCommit();
    } else {
      this.#stage = "waiting_for_configuration";
      this.#diagnose("finish.queued", this.#audioDiagnostic());
    }
    return this.#finishPromise;
  }

  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#stage = "aborted";
    this.#queuedAudio.length = 0;
    this.#items.clear();
    this.#diagnose("session.aborted", this.#audioDiagnostic());

    if (this.#finishPromise && !this.#settled) {
      this.#reject(this.#error("session was aborted"));
    }
    this.#closeSocket();
  }

  #onOpen() {
    if (this.#aborted || this.#failure || this.#opened) {
      if (this.#aborted || this.#failure) this.#closeSocket();
      return;
    }

    this.#opened = true;
    this.#startHeartbeat();
    this.#stage = "configuring";
    this.#diagnose("socket.open");
    const transcription = {
      model: this.model,
      delay: this.delay,
    };
    // GPT Live Transcribe accepts multiple expected language hints. Preserve
    // the legacy singular field when a caller intentionally pins an older
    // Realtime transcription model.
    if (this.model === "gpt-live-transcribe" || this.model === "gpt-transcribe") {
      transcription.languages = [this.language];
    } else {
      transcription.language = this.language;
    }
    this.#send({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: this.sampleRate,
            },
            transcription: {
              ...transcription,
            },
            turn_detection: null,
          },
        },
      },
    });
  }

  #onMessage(raw) {
    if (this.#settled || this.#aborted || this.#failure) return;

    let event;
    try {
      event = JSON.parse(messageText(raw));
    } catch {
      this.#fail("server returned invalid JSON");
      return;
    }

    if (event?.type === "session.created") {
      this.#diagnose("session.created", {
        serverSessionId: optionalIdentifier(event.session?.id),
      });
      return;
    }
    if (event?.type === "session.updated") {
      this.#onSessionUpdated(event);
      return;
    }
    if (event?.type === "input_audio_buffer.committed") {
      this.#onAudioCommitted(event);
      return;
    }
    if (event?.type === "conversation.item.input_audio_transcription.delta") {
      this.#onTranscriptDelta(event);
      return;
    }
    if (event?.type === "conversation.item.input_audio_transcription.completed") {
      this.#onTranscriptCompleted(event);
      return;
    }
    if (event?.type === "conversation.item.input_audio_transcription.failed") {
      this.#onTranscriptFailed(event);
      return;
    }
    if (event?.type === "error") {
      const detail = event.error?.message || event.error?.code || event.error?.type || "server error";
      this.#diagnose("server.error", {
        errorCode: optionalIdentifier(event.error?.code),
        errorType: optionalIdentifier(event.error?.type),
      });
      this.#fail("server error", new Error(String(detail)));
    }
  }

  #onSessionUpdated(event) {
    if (this.#configured) {
      this.#diagnose("session.updated_ignored", { reason: "already_configured" });
      return;
    }
    if (event.session?.type && event.session.type !== "transcription") {
      this.#fail("server configured a non-transcription session");
      return;
    }

    this.#configured = true;
    clearTimeout(this.#connectionTimer);
    this.#connectionTimer = undefined;
    this.#stage = this.#finishRequested ? "flushing_audio" : "recording";
    this.#diagnose("session.updated", {
      serverSessionId: optionalIdentifier(event.session?.id),
      queuedChunks: this.#queuedAudio.length,
      ...this.#audioDiagnostic(),
    });

    const queuedAudio = this.#queuedAudio;
    this.#queuedAudio = [];
    for (const audio of queuedAudio) {
      this.#send({ type: "input_audio_buffer.append", audio });
      if (this.#failure) return;
    }
    if (this.#finishRequested) this.#sendCommit();
  }

  #onAudioCommitted(event) {
    if (!this.#commitSent) {
      this.#diagnose("input_audio_buffer.committed_ignored", {
        reason: "no_local_commit",
        itemId: optionalIdentifier(event.item_id),
      });
      return;
    }

    const itemId = requiredIdentifier(event.item_id);
    if (!itemId) {
      this.#fail("server committed audio without an item_id");
      return;
    }
    if (this.#committedItemId && this.#committedItemId !== itemId) {
      this.#diagnose("input_audio_buffer.committed_ignored", {
        reason: "different_item",
        itemId,
        committedItemId: this.#committedItemId,
      });
      return;
    }
    if (this.#committedItemId === itemId) {
      this.#diagnose("input_audio_buffer.committed_ignored", {
        reason: "duplicate",
        itemId,
      });
      return;
    }
    if (this.#liveItemId && this.#liveItemId !== itemId) {
      this.#diagnose("input_audio_buffer.committed_mismatch", {
        itemId,
        liveItemId: this.#liveItemId,
      });
      this.#fail("server committed a different live transcription item");
      return;
    }

    this.#committedItemId = itemId;
    this.#stage = "transcribing";
    this.#diagnose("input_audio_buffer.committed", {
      itemId,
      eventId: optionalIdentifier(event.event_id),
      ...this.#audioDiagnostic(),
    });
    this.#activateCommittedItem();
  }

  #onTranscriptDelta(event) {
    const itemId = requiredIdentifier(event.item_id);
    if (!itemId) {
      this.#diagnose("transcript.delta_ignored", { reason: "missing_item_id" });
      return;
    }
    if (this.#committedItemId && itemId !== this.#committedItemId) {
      this.#diagnose("transcript.delta_ignored", {
        reason: "different_item",
        itemId,
        committedItemId: this.#committedItemId,
      });
      return;
    }
    if (!this.#committedItemId && this.model === "gpt-live-transcribe") {
      if (this.#liveItemId && itemId !== this.#liveItemId) {
        this.#diagnose("transcript.delta_ignored", {
          reason: "different_live_item",
          itemId,
          liveItemId: this.#liveItemId,
        });
        return;
      }
      this.#liveItemId = itemId;
    }

    const item = this.#item(itemId);
    if (item.terminal) {
      this.#diagnose("transcript.delta_ignored", {
        reason: "item_already_terminal",
        itemId,
      });
      return;
    }
    const delta = String(event.delta ?? "");
    item.deltas.push({ delta, event });
    if (itemId === this.#committedItemId || itemId === this.#liveItemId) {
      this.#emitPendingDeltas(itemId, item);
    }
  }

  #onTranscriptCompleted(event) {
    const itemId = requiredIdentifier(event.item_id);
    if (!itemId) {
      this.#diagnose("transcript.completed_ignored", { reason: "missing_item_id" });
      return;
    }
    if (this.#committedItemId && itemId !== this.#committedItemId) {
      this.#diagnose("transcript.completed_ignored", {
        reason: "different_item",
        itemId,
        committedItemId: this.#committedItemId,
      });
      return;
    }

    const item = this.#item(itemId);
    if (item.terminal) {
      this.#diagnose("transcript.completed_ignored", {
        reason: "duplicate_terminal",
        itemId,
      });
      return;
    }
    item.terminal = { kind: "completed", event };
    if (itemId === this.#committedItemId) this.#finishCommittedItem(itemId, item);
  }

  #onTranscriptFailed(event) {
    const itemId = requiredIdentifier(event.item_id);
    if (!itemId) {
      this.#diagnose("transcript.failed_ignored", { reason: "missing_item_id" });
      return;
    }
    if (this.#committedItemId && itemId !== this.#committedItemId) {
      this.#diagnose("transcript.failed_ignored", {
        reason: "different_item",
        itemId,
        committedItemId: this.#committedItemId,
      });
      return;
    }

    const item = this.#item(itemId);
    if (item.terminal) {
      this.#diagnose("transcript.failed_ignored", {
        reason: "duplicate_terminal",
        itemId,
      });
      return;
    }
    item.terminal = { kind: "failed", event };
    if (itemId === this.#committedItemId) this.#finishCommittedItem(itemId, item);
  }

  #activateCommittedItem() {
    const item = this.#items.get(this.#committedItemId);
    if (!item) return;
    this.#emitPendingDeltas(this.#committedItemId, item);
    if (item.terminal) this.#finishCommittedItem(this.#committedItemId, item);
  }

  #emitPendingDeltas(itemId, item) {
    while (item.emittedDeltas < item.deltas.length) {
      const { delta, event } = item.deltas[item.emittedDeltas++];
      if (!this.#firstDeltaSeen && delta) {
        this.#firstDeltaSeen = true;
        this.#diagnose("transcript.first_delta", {
          itemId,
          deltaChars: delta.length,
        });
      }
      this.emit("delta", delta, event);
    }
  }

  #finishCommittedItem(itemId, item) {
    this.#emitPendingDeltas(itemId, item);
    if (item.terminal.kind === "failed") {
      const event = item.terminal.event;
      const detail = event.error?.message ||
        event.error?.code ||
        event.error?.type ||
        "transcription failed";
      this.#diagnose("transcript.failed", {
        itemId,
        eventId: optionalIdentifier(event.event_id),
        errorCode: optionalIdentifier(event.error?.code),
        errorType: optionalIdentifier(event.error?.type),
      });
      this.#fail("request failed", new Error(String(detail)));
      return;
    }

    const event = item.terminal.event;
    const finalTranscript = String(event.transcript ?? "").trim();
    const partialTranscript = item.deltas.map(({ delta }) => delta).join("").trim();
    const transcript = finalTranscript || partialTranscript;
    if (!transcript) {
      this.#diagnose("transcript.no_speech", {
        itemId,
        eventId: optionalIdentifier(event.event_id),
        ...this.#audioDiagnostic(),
      });
      this.#fail("detected no speech in the committed audio", undefined, true, "NO_SPEECH");
      return;
    }

    this.#stage = "completed";
    this.#diagnose("transcript.completed", {
      itemId,
      eventId: optionalIdentifier(event.event_id),
      transcriptChars: transcript.length,
      usedPartial: finalTranscript.length === 0,
      ...this.#audioDiagnostic(),
    });
    this.#resolve(transcript);
    this.#closeSocket();
  }

  #item(itemId) {
    let item = this.#items.get(itemId);
    if (!item) {
      item = { deltas: [], emittedDeltas: 0, terminal: null };
      this.#items.set(itemId, item);
    }
    return item;
  }

  #onClose() {
    if (this.#aborted || this.#settled) return;
    this.#diagnose("socket.closed", this.#audioDiagnostic());
    this.#clearHealthTimers();
    this.#fail("connection closed before transcription completed", undefined, false, "REALTIME_CONNECTION_LOST");
  }

  #sendCommit() {
    if (this.#commitSent || this.#failure || this.#aborted) return;
    this.#commitSent = true;
    this.#stage = "waiting_for_commit";
    this.#diagnose("input_audio_buffer.commit_sent", this.#audioDiagnostic());
    this.#send({ type: "input_audio_buffer.commit" });
  }

  #send(event) {
    if (this.#failure || this.#aborted) return;
    try {
      if (this.#socket.readyState !== undefined && this.#socket.readyState !== OPEN) {
        throw new Error("WebSocket is not open");
      }
      this.#socket.send(JSON.stringify(event), (error) => {
        if (error) this.#fail("send failed", error, true, "REALTIME_CONNECTION_LOST");
      });
    } catch (error) {
      this.#fail("send failed", error, true, "REALTIME_CONNECTION_LOST");
    }
  }

  #fail(context, cause, close = true, code) {
    if (this.#settled || this.#aborted || this.#failure) return;
    this.#failure = this.#error(context, cause);
    if (code) this.#failure.code = code;
    this.#failure.transcriptStarted = this.#firstDeltaSeen;
    this.#stage = "failed";
    this.#diagnose("session.failed", {
      context,
      code: code || undefined,
      ...this.#audioDiagnostic(),
    });
    if (this.#finishPromise) this.#reject(this.#failure);
    if (close) this.#closeSocket(Boolean(code));
  }

  #resolve(transcript) {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimeout();
    this.#resolveFinish?.(transcript);
  }

  #reject(error) {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimeout();
    this.#rejectFinish?.(error);
  }

  #startHeartbeat() {
    if (typeof this.#socket.ping !== "function") return;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#pendingPing !== undefined || this.#failure || this.#aborted || this.#settled) return;
      this.#pendingPing = String(++this.#pingSequence);
      this.#pongTimer = setTimeout(() => {
        this.#fail("connection heartbeat timed out", undefined, true, "REALTIME_CONNECTION_LOST");
      }, this.heartbeatTimeoutMs);
      this.#pongTimer.unref?.();
      try {
        this.#socket.ping(this.#pendingPing, (error) => {
          if (error) this.#fail("connection ping failed", error, true, "REALTIME_CONNECTION_LOST");
        });
      } catch (error) {
        this.#fail("connection ping failed", error, true, "REALTIME_CONNECTION_LOST");
      }
    }, this.heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #clearHealthTimers() {
    clearTimeout(this.#connectionTimer);
    clearTimeout(this.#idleTimer);
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#pongTimer);
    this.#connectionTimer = this.#idleTimer = this.#heartbeatTimer = this.#pongTimer = undefined;
    this.#pendingPing = undefined;
  }

  #closeSocket(force = false) {
    this.#clearHealthTimers();
    const socket = this.#socket;
    if (!socket || socket.readyState === socket.CLOSED || socket.readyState === 3) return;
    try {
      if (force && typeof socket.terminate === "function") socket.terminate();
      else socket.close();
    } catch {
      // Closing is best-effort after completion, failure, or abort.
    }
  }

  #clearTimeout() {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
  }

  #audioDurationMs() {
    return Math.round(
      (this.#audioBytes * 1000) /
      (this.sampleRate * this.numChannels * 2),
    );
  }

  #audioDiagnostic() {
    return {
      audioBytes: this.#audioBytes,
      audioChunks: this.#audioChunks,
      audioMs: this.#audioDurationMs(),
      committedItemId: this.#committedItemId,
    };
  }

  #diagnose(event, details = {}) {
    const diagnostic = {
      event,
      stage: this.#stage,
      elapsedMs: Math.max(0, Date.now() - this.#startedAt),
      ...withoutUndefined(details),
    };
    try {
      this.#logger?.(diagnostic);
    } catch {
      // Diagnostics must never disrupt audio streaming or finalization.
    }
    try {
      this.emit("diagnostic", diagnostic);
    } catch {
      // Diagnostics must never disrupt audio streaming or finalization.
    }
  }

  #error(context, cause) {
    const detail = cause === undefined ? "" : `: ${safeErrorMessage(cause, this.#apiKey)}`;
    return new Error(`OpenAI realtime transcription ${context}${detail}`);
  }
}

function defaultWebSocketFactory(url, options) {
  return new WebSocket(url, options);
}

function requiredString(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalString(value, fallback, name) {
  const text = value === undefined ? fallback : String(value).trim();
  if (!text) throw new Error(`${name} must be a non-empty string`);
  return text;
}

function validateSampleRate(value) {
  if (Number(value) !== REQUIRED_SAMPLE_RATE) {
    throw new Error(`realtime transcription sampleRate must be ${REQUIRED_SAMPLE_RATE}`);
  }
  return REQUIRED_SAMPLE_RATE;
}

function validateChannels(value) {
  if (Number(value) !== REQUIRED_CHANNELS) {
    throw new Error("realtime transcription audio must be mono");
  }
  return REQUIRED_CHANNELS;
}

function positiveNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

function validateBase64(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("realtime transcription audio must be a non-empty base64 string");
  }
  if (value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("realtime transcription audio must be valid base64");
  }
  return value;
}

function base64DecodedLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function requiredIdentifier(value) {
  const identifier = optionalIdentifier(value);
  return identifier || "";
}

function optionalIdentifier(value) {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return identifier || undefined;
}

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function messageText(raw) {
  const data = raw?.data ?? raw;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function safeErrorMessage(error, secret) {
  let message = String(error?.message || error || "unknown error");
  if (secret) message = message.split(secret).join("[REDACTED]");
  return message;
}
