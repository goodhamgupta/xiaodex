import { EventEmitter } from "node:events";
import { RealtimeTranscriptionSession } from "./realtime-transcription.mjs";

const REALTIME_SAMPLE_RATE = 24_000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
const DEFAULT_TRANSCRIPTION_DELAY = "low";
const EMPTY_TRANSCRIPT_RETRY_DELAY = "medium";
const EMPTY_TRANSCRIPT_RETRY_MIN_AUDIO_MS = 500;
const TRANSCRIPTION_DELAYS = ["minimal", "low", "medium", "high", "xhigh"];
const MAX_AUDIO_SECONDS = 30;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;
const MAX_WAV_HEADER_BYTES = 4096;
const COMPATIBILITY_CHUNK_BYTES = 32 * 1024;

export class VoiceController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codex = options.codex;
    this.cwd = options.cwd || process.cwd();
    this.transcriptTimeoutMs = positiveNumber(options.transcriptTimeoutMs, 10000);
    this.openaiApiKey = hostOption(options, "openaiApiKey", "OPENAI_API_KEY").trim();
    this.provider = validateOpenAIProvider(
      aliasedHostOption(options, "provider", ["voiceProvider"], "CODEX_BUDDY_VOICE_PROVIDER"),
    );
    this.model = validateTranscriptionModel(
      aliasedHostOption(
        options,
        "model",
        ["transcriptionModel", "voiceModel"],
        "CODEX_BUDDY_VOICE_MODEL",
      ),
    );
    this.language = validateLanguage(
      aliasedHostOption(
        options,
        "language",
        ["transcriptionLanguage", "voiceLanguage"],
        "CODEX_BUDDY_VOICE_LANGUAGE",
      ),
    );
    this.delay = validateDelay(
      aliasedHostOption(
        options,
        "delay",
        ["transcriptionDelay", "voiceDelay"],
        "CODEX_BUDDY_VOICE_DELAY",
      ),
    );
    if (options.resolveThreadId !== undefined &&
        typeof options.resolveThreadId !== "function") {
      throw new TypeError("voice resolveThreadId must be a function");
    }
    this.resolveThreadId = options.resolveThreadId;
    const threadIdAliases = ["targetThreadId", "voiceThreadId"];
    const hasExplicitThreadId = ["threadId", ...threadIdAliases]
      .some((name) => options[name] !== undefined);
    this.threadId = validateTrustedThreadId(
      this.resolveThreadId && !hasExplicitThreadId
        ? ""
        : aliasedHostOption(
          options,
          "threadId",
          threadIdAliases,
          "CODEX_BUDDY_VOICE_THREAD_ID",
        ),
    );
    this.webSocketFactory = options.webSocketFactory;
    this.realtimeLogger = typeof options.realtimeLogger === "function"
      ? options.realtimeLogger
      : undefined;
    this.realtimeSessionFactory = options.realtimeSessionFactory ||
      ((sessionOptions) => new RealtimeTranscriptionSession(sessionOptions));
    this.activeStream = null;
    this.stopped = false;
    this.prewarmEnabled = options.prewarm === true;
    this.prewarmedRealtime = null;
    this.prewarmTimer = null;
    this.#ensurePrewarm();
    if (this.prewarmEnabled && this.openaiApiKey) {
      this.prewarmTimer = setInterval(() => this.#ensurePrewarm(),
        positiveNumber(options.prewarmRefreshMs, 5000));
      this.prewarmTimer.unref?.();
    }
  }

  beginPcmAudio(options = {}) {
    if (!this.codex) throw new Error("voice requires a Codex app-server client");
    if (this.stopped) throw new Error("voice controller is stopped");
    if (this.activeStream) throw new Error("voice transcription already in progress");
    if (!this.openaiApiKey) {
      throw new Error(
        "on-device voice transcription requires OPENAI_API_KEY in the Mac bridge environment",
      );
    }

    const sampleRate = validateSampleRate(options.sampleRate ?? REALTIME_SAMPLE_RATE);
    const numChannels = validateChannels(options.numChannels ?? DEFAULT_CHANNELS);
    if (sampleRate !== REALTIME_SAMPLE_RATE) {
      throw new Error(
        `OpenAI Realtime transcription requires ${REALTIME_SAMPLE_RATE} Hz mono PCM`,
      );
    }

    const ownership = {};
    this.activeStream = ownership;
    let realtime;
    try {
      realtime = this.#takeRealtime(sampleRate, numChannels);
    } catch (error) {
      if (this.activeStream === ownership) this.activeStream = null;
      throw error;
    }

    const targetPromise = this.#targetThread(options.threadId);
    // The target is intentionally resolved while the user is speaking. Attach
    // a handler immediately so an early app-server failure is reported by
    // finish(), not as an unhandled rejection.
    targetPromise.catch(() => {});

    const defaultSubmit = options.submit !== false;
    const onFinalTranscript = typeof options.onFinalTranscript === "function"
      ? options.onFinalTranscript
      : null;
    let state = "recording";
    let bytes = 0;
    const replayAudio = [];
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : null;
    const handleDelta = (delta, event) => {
      if (!onDelta || (state !== "recording" && state !== "finishing")) return;
      onDelta(delta, event);
    };
    const attachDelta = (session) => {
      if (onDelta && typeof session.on === "function") {
        session.on("delta", handleDelta);
      }
    };
    const detachDelta = (session) => {
      if (!onDelta) return;
      if (typeof session.off === "function") session.off("delta", handleDelta);
      else session.removeListener?.("delta", handleDelta);
    };
    attachDelta(realtime);

    const appendBase64 = (audio, knownBytes) => {
      if (state !== "recording") throw new Error("voice recording is not accepting audio");
      const byteLength = validateBase64Pcm16(audio, knownBytes);
      validateDuration(bytes + byteLength, sampleRate, numChannels);
      realtime.appendBase64(audio);
      replayAudio.push(audio);
      bytes += byteLength;
    };

    const appendPcm = (pcm) => {
      const audio = copyBytes(pcm);
      if (audio.length === 0 || audio.length % (2 * numChannels) !== 0) {
        throw new Error("PCM16 audio length must contain complete samples");
      }
      appendBase64(audio.toString("base64"), audio.length);
    };

    const finish = async (finishOptions = {}) => {
      if (state !== "recording") {
        throw new Error(
          state === "finishing"
            ? "voice transcription is already finishing"
            : "voice recording is no longer active",
        );
      }
      if (bytes === 0) {
        abort();
        throw new Error("voice capture produced no audio");
      }
      state = "finishing";

      try {
        const submitted = finishOptions.submit ?? defaultSubmit;
        const transcriptPromise = finishRealtime().then((transcript) => {
          if (state === "aborted") throw new Error("voice transcription aborted");
          if (state === "finishing" && onFinalTranscript) {
            try {
              // This callback runs as soon as Realtime finalizes, without
              // waiting for a slow Codex thread lookup. It still precedes
              // turn/start, so the device can display the authoritative text
              // while submission proceeds in the background.
              onFinalTranscript(transcript, { submitted });
            } catch (error) {
              try {
                this.realtimeLogger?.({
                  event: "transcription.callback_failed",
                  error: String(error?.message || error),
                });
              } catch {
                // A display/diagnostic callback must never block submission.
              }
            }
          }
          return transcript;
        });
        const [transcript, threadId] = await Promise.all([
          transcriptPromise,
          targetPromise,
        ]);
        if (state === "aborted") throw new Error("voice transcription aborted");

        let acceptedTurn;
        if (submitted) {
          acceptedTurn = await this.codex.request("turn/start", {
            threadId,
            input: [{ type: "text", text: transcript, text_elements: [] }],
            // Voice turns are controlled from the physical buddy. Keep
            // command approvals with that user instead of allowing a host
            // auto-reviewer to resolve them before the device can respond.
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
          });
        }
        if (state === "aborted") throw new Error("voice transcription aborted");
        state = "done";
        return voiceResult({ threadId, transcript, submitted, acceptedTurn });
      } catch (error) {
        if (state !== "aborted") state = "failed";
        realtime.abort();
        throw error;
      } finally {
        detachDelta(realtime);
        replayAudio.length = 0;
        // An aborted finishing stream may settle after a replacement has
        // started. Never let its late finally release the newer stream.
        if (this.activeStream === ownership) this.activeStream = null;
        this.#ensurePrewarm();
      }
    };

    const finishRealtime = async () => {
      try {
        return await realtime.finish();
      } catch (error) {
        const audioMs = bytes * 1000 / (sampleRate * numChannels * 2);
        const noSpeech = error?.code === "NO_SPEECH";
        const connectionFailure = ["TRANSCRIPTION_TIMEOUT", "REALTIME_CONNECTION_LOST"]
          .includes(error?.code) && error.transcriptStarted !== true;
        if (state !== "finishing" ||
            (!noSpeech && !connectionFailure) ||
            audioMs < EMPTY_TRANSCRIPT_RETRY_MIN_AUDIO_MS) {
          throw error;
        }

        const retryDelay = noSpeech ? moreConservativeDelay(
          this.delay,
          EMPTY_TRANSCRIPT_RETRY_DELAY,
        ) : this.delay;
        const failedRealtime = realtime;
        detachDelta(failedRealtime);
        failedRealtime.abort();
        try {
          this.realtimeLogger?.({
            event: "transcription.retry",
            reason: error.code,
            audioBytes: bytes,
            audioMs: Math.round(audioMs),
            fromDelay: this.delay,
            toDelay: retryDelay,
          });
        } catch {
          // Diagnostics must never disrupt transcription recovery.
        }

        realtime = this.#createRealtime(sampleRate, numChannels, {
          delay: retryDelay,
        });
        attachDelta(realtime);
        for (const audio of replayAudio) realtime.appendBase64(audio);
        return realtime.finish();
      }
    };

    const abort = () => {
      if (state === "done" || state === "aborted") return;
      const reusable = state === "recording" && bytes === 0 &&
        this.prewarmEnabled && !this.stopped &&
        this.activeStream === ownership && realtime.isUsable !== false;
      state = "aborted";
      detachDelta(realtime);
      if (reusable) this.prewarmedRealtime = realtime;
      else realtime.abort();
      replayAudio.length = 0;
      if (this.activeStream === ownership) this.activeStream = null;
      this.#ensurePrewarm();
    };
    ownership.abort = abort;

    return {
      appendBase64,
      appendPcm,
      finish,
      abort,
      get bytes() {
        return bytes;
      },
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.prewarmTimer);
    this.prewarmTimer = null;
    this.activeStream?.abort?.();
    this.prewarmedRealtime?.abort?.();
    this.prewarmedRealtime = null;
  }

  // Compatibility helpers for callers that already have a complete recording.
  // They still use Realtime; audio is chunked into the live session and then
  // manually committed instead of being uploaded as a WAV request.
  async submitPcmAudio(options = {}) {
    return this.submitAudio({
      audio: options.pcm,
      format: "pcm_s16le",
      sampleRate: options.sampleRate ?? REALTIME_SAMPLE_RATE,
      numChannels: options.numChannels ?? DEFAULT_CHANNELS,
      submit: options.submit,
      threadId: options.threadId,
    });
  }

  async submitAudio(options = {}) {
    const prepared = prepareAudio(options);
    const stream = this.beginPcmAudio({
      sampleRate: prepared.sampleRate,
      numChannels: prepared.numChannels,
      submit: options.submit,
      threadId: options.threadId,
    });
    try {
      for (let offset = 0; offset < prepared.pcm.length; offset += COMPATIBILITY_CHUNK_BYTES) {
        stream.appendPcm(prepared.pcm.subarray(offset, offset + COMPATIBILITY_CHUNK_BYTES));
      }
      return await stream.finish();
    } catch (error) {
      stream.abort();
      throw error;
    }
  }

  // Compatibility entry point for callers migrating from the former Mac
  // microphone implementation. It never captures locally; audio must already
  // have arrived from the device bridge.
  async captureAndSubmit(options = {}) {
    if (options.pcm !== undefined) return this.submitPcmAudio(options);
    if (options.audio !== undefined) return this.submitAudio(options);
    throw new Error(
      "voice capture requires PCM or WAV audio from the M5StickC Plus; Mac microphone capture was removed",
    );
  }

  #createRealtime(
    sampleRate = REALTIME_SAMPLE_RATE,
    numChannels = DEFAULT_CHANNELS,
    overrides = {},
  ) {
    return this.realtimeSessionFactory({
      apiKey: this.openaiApiKey,
      model: this.model,
      sampleRate,
      numChannels,
      language: this.language,
      delay: overrides.delay ?? this.delay,
      transcriptTimeoutMs: this.transcriptTimeoutMs,
      webSocketFactory: this.webSocketFactory,
      logger: this.realtimeLogger,
    });
  }

  #ensurePrewarm() {
    if (this.stopped ||
        !this.prewarmEnabled ||
        !this.openaiApiKey ||
        this.activeStream) return;
    if (this.prewarmedRealtime?.isUsable !== false && this.prewarmedRealtime) return;
    try {
      this.prewarmedRealtime?.abort?.();
      this.prewarmedRealtime = this.#createRealtime();
    } catch {
      // A press still gets a normal, surfaced connection attempt. Prewarming
      // is only a latency optimization and must not stop the bridge booting.
      this.prewarmedRealtime = null;
    }
  }

  #takeRealtime(sampleRate, numChannels) {
    const prewarmed = this.prewarmedRealtime;
    this.prewarmedRealtime = null;
    if (prewarmed?.isUsable !== false && prewarmed) return prewarmed;
    prewarmed?.abort?.();
    return this.#createRealtime(sampleRate, numChannels);
  }

  async #targetThread(perCallThreadId) {
    if (perCallThreadId === undefined && !this.threadId && this.resolveThreadId) {
      const resolvedThreadId = validateTrustedThreadId(await this.resolveThreadId());
      if (!resolvedThreadId) {
        throw new Error("latest voice task resolver did not return a task id");
      }
      await this.#resumeThread(resolvedThreadId);
      return resolvedThreadId;
    }

    const candidate = perCallThreadId === undefined ? this.threadId : perCallThreadId;
    const trustedThreadId = validateTrustedThreadId(candidate);
    if (trustedThreadId) {
      await this.#resumeThread(trustedThreadId);
      return trustedThreadId;
    }

    const listed = await this.codex.request("thread/list", {
      limit: 10,
      cwd: this.cwd,
      sortKey: "updated_at",
      sortDirection: "desc",
      useStateDbOnly: true,
      archived: false,
    });
    const threads = listed?.data || [];
    const active = threads.find((thread) => thread?.status?.type === "active");
    const newest = active || threads[0];
    if (newest?.id) {
      await this.#resumeThread(newest.id);
      this.threadId = newest.id;
      return newest.id;
    }

    const started = await this.codex.request("thread/start", { cwd: this.cwd });
    const id = started?.thread?.id;
    if (!id) throw new Error("Codex app-server did not return a thread id");
    this.threadId = id;
    return id;
  }

  async #resumeThread(threadId) {
    const resumed = await this.codex.request("thread/resume", { threadId });
    const resumedId = resumed?.thread?.id;
    if (resumedId !== threadId) {
      throw new Error("Codex app-server did not resume the requested thread");
    }
  }
}

function prepareAudio(options) {
  const audio = copyBytes(options.audio);
  if (audio.length === 0) throw new Error("voice capture produced no audio");

  const requestedFormat = String(options.format || "pcm_s16le").trim().toLowerCase();
  if (["pcm_s16le", "pcm16", "s16le"].includes(requestedFormat)) {
    const sampleRate = validateSampleRate(options.sampleRate ?? REALTIME_SAMPLE_RATE);
    const numChannels = validateChannels(options.numChannels ?? DEFAULT_CHANNELS);
    if (audio.length % (2 * numChannels) !== 0) {
      throw new Error("PCM16 audio length must contain complete samples");
    }
    validateDuration(audio.length, sampleRate, numChannels);
    return { pcm: audio, sampleRate, numChannels };
  }

  if (["wav", "audio/wav"].includes(requestedFormat)) {
    const metadata = parsePcm16Wav(audio);
    if (options.sampleRate !== undefined &&
        validateSampleRate(options.sampleRate) !== metadata.sampleRate) {
      throw new Error("WAV sample rate does not match the bridge metadata");
    }
    if (options.numChannels !== undefined &&
        validateChannels(options.numChannels) !== metadata.numChannels) {
      throw new Error("WAV channel count does not match the bridge metadata");
    }
    validateDuration(metadata.dataBytes, metadata.sampleRate, metadata.numChannels);
    return {
      pcm: audio.subarray(metadata.dataOffset, metadata.dataOffset + metadata.dataBytes),
      sampleRate: metadata.sampleRate,
      numChannels: metadata.numChannels,
    };
  }

  throw new Error("voice audio format must be pcm_s16le or wav");
}

function copyBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("voice audio must be a Buffer, ArrayBuffer, or typed array");
}

function validateBase64Pcm16(value, knownBytes) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("voice audio must be non-empty base64");
  }
  let byteLength = knownBytes;
  if (byteLength === undefined) {
    if (value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("voice audio contains invalid base64");
    }
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) {
      throw new Error("voice audio contains invalid base64");
    }
    byteLength = decoded.length;
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength % 2 !== 0) {
    throw new Error("PCM16 audio length must contain complete samples");
  }
  return byteLength;
}

function validateSampleRate(value) {
  const sampleRate = Number(value);
  if (!Number.isInteger(sampleRate) ||
      sampleRate < MIN_SAMPLE_RATE ||
      sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`voice sampleRate must be an integer from ${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE}`);
  }
  return sampleRate;
}

function validateChannels(value) {
  const numChannels = Number(value);
  if (numChannels !== 1) throw new Error("on-device voice audio must be mono");
  return numChannels;
}

function validateDuration(dataBytes, sampleRate, numChannels) {
  const maxBytes = sampleRate * numChannels * 2 * MAX_AUDIO_SECONDS;
  if (dataBytes > maxBytes) {
    throw new Error(`voice audio exceeds the ${MAX_AUDIO_SECONDS}-second limit`);
  }
}

function parsePcm16Wav(wav) {
  if (wav.length < 44 ||
      wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("voice WAV data has an invalid header");
  }
  if (wav.length > MAX_SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS + MAX_WAV_HEADER_BYTES) {
    throw new Error(`voice audio exceeds the ${MAX_AUDIO_SECONDS}-second limit`);
  }

  let format;
  let dataBytes;
  let dataOffset;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new Error("voice WAV data contains a truncated chunk");

    if (id === "fmt ") {
      if (size < 16) throw new Error("voice WAV format chunk is invalid");
      format = {
        encoding: wav.readUInt16LE(start),
        numChannels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      dataBytes = size;
      dataOffset = start;
    }
    offset = end + (size % 2);
  }

  if (!format || dataBytes === undefined || dataOffset === undefined) {
    throw new Error("voice WAV data must contain format and data chunks");
  }
  if (format.encoding !== 1 || format.bitsPerSample !== 16) {
    throw new Error("voice WAV data must contain PCM16 samples");
  }
  validateSampleRate(format.sampleRate);
  validateChannels(format.numChannels);
  if (dataBytes % (2 * format.numChannels) !== 0) {
    throw new Error("WAV PCM16 data length must contain complete samples");
  }
  return { ...format, dataBytes, dataOffset };
}

function hostOption(options, optionName, environmentName) {
  const value = options[optionName] !== undefined ? options[optionName] : process.env[environmentName];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError(`${optionName} must be a string`);
  return value;
}

function aliasedHostOption(options, optionName, aliases, environmentName) {
  for (const name of [optionName, ...aliases]) {
    if (options[name] !== undefined) return hostOption(options, name, environmentName);
  }
  return hostOption(options, optionName, environmentName);
}

function validateOpenAIProvider(value) {
  const provider = value.trim().toLowerCase() || "openai";
  if (provider === "openai" || provider === "auto") return "openai";
  throw new Error("on-device voice transcription supports only the OpenAI provider");
}

function validateTranscriptionModel(value) {
  const model = value.trim() || DEFAULT_TRANSCRIPTION_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw new Error("voice transcription model contains invalid characters");
  }
  return model;
}

function validateLanguage(value) {
  const language = value.trim() || DEFAULT_TRANSCRIPTION_LANGUAGE;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new Error("voice transcription language must be a BCP-47-style tag");
  }
  return language;
}

function validateDelay(value) {
  const delay = value.trim().toLowerCase() || DEFAULT_TRANSCRIPTION_DELAY;
  if (!TRANSCRIPTION_DELAYS.includes(delay)) {
    throw new Error("voice transcription delay must be minimal, low, medium, high, or xhigh");
  }
  return delay;
}

function moreConservativeDelay(first, second) {
  return TRANSCRIPTION_DELAYS[
    Math.max(TRANSCRIPTION_DELAYS.indexOf(first), TRANSCRIPTION_DELAYS.indexOf(second))
  ];
}

function validateTrustedThreadId(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError("voice threadId must be a string");
  const threadId = value.trim();
  if (!threadId) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(threadId)) {
    throw new Error("voice threadId contains invalid characters");
  }
  return threadId;
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function voiceResult({ threadId, transcript, submitted, acceptedTurn }) {
  const result = { threadId, transcript, submitted };
  const turn = acceptedTurn?.turn || acceptedTurn;
  if (turn?.id) result.turnId = turn.id;
  const status = typeof turn?.status === "string" ? turn.status : turn?.status?.type;
  if (status) result.turnStatus = status;
  return result;
}
