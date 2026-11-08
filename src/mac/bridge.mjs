import os from "node:os";
import { performance } from "node:perf_hooks";
import { CodexJsonRpcClient } from "./json-rpc-client.mjs";
import { DesktopCodexClient } from "./desktop-codex-client.mjs";
import { DeviceServer } from "./device-server.mjs";
import { SnapshotState, isApprovalMethod } from "./snapshot.mjs";
import { DesktopSessionLogFollower } from "./session-log.mjs";
import { DesktopApprovalController } from "./desktop-approval.mjs";
import { VoiceController } from "./voice.mjs";

const VOICE_REALTIME_SAMPLE_RATE = 24_000;
const VOICE_WIFI_UDP_SAMPLE_RATE = 16_000;
const VOICE_NUM_CHANNELS = 1;
const VOICE_FORMAT = "pcm_s16le";
const VOICE_BYTES_PER_SAMPLE = 2;
const VOICE_MAX_SECONDS = 30;
const VOICE_MAX_PCM_BYTES =
  VOICE_REALTIME_SAMPLE_RATE * VOICE_BYTES_PER_SAMPLE * VOICE_MAX_SECONDS;
// Older firmware can still batch two 20 ms blocks into one base64/TCP frame.
// Current firmware uses one raw 960-byte block per sub-MTU UDP datagram.
const VOICE_MAX_CHUNK_BYTES = 1_920;
const VOICE_MAX_UDP_CHUNK_BYTES = 960;
const DEFAULT_VOICE_SESSION_TIMEOUT_MS = 35_000;
const DEFAULT_VOICE_UDP_REORDER_WINDOW = 8;
const DEFAULT_VOICE_UDP_STOP_GRACE_MS = 160;
const VOICE_DELTA_INTERVAL_MS = 125;
// Voice frames share the ESP32's fixed 1024-byte JSONL receive buffer. Keep a
// substantially larger cumulative tail than the old three-line card allowed,
// while leaving headroom for JSON escaping and lifecycle metadata.
const VOICE_PREVIEW_BYTES = 320;
const DEFAULT_ASSISTANT_DELTA_INTERVAL_MS = 125;
// Keep enough of the response for several Button B scroll views. Serialized
// frames are still trimmed below DEVICE_RX_LINE_BYTES by assistantFrame(), so
// escape-heavy text and maximum-length IDs remain safe for the ESP32 parser.
const ASSISTANT_PREVIEW_BYTES = 640;
const ASSISTANT_ACCUMULATOR_BYTES = 16 * 1024;
const ASSISTANT_ID_BYTES = 80;
const DEVICE_RX_LINE_BYTES = 1024;
const DEFAULT_ASSISTANT_REPLAY_MS = 30_000;
const DEFAULT_ASSISTANT_STREAM_TIMEOUT_MS = 60_000;

export class CodexBuddyBridge {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.pollMs = Number(options.pollMs || 5000);
    this.heartbeatMs = Number(options.heartbeatMs || 10000);
    this.owner = options.owner || process.env.USER || "Codex";
    this.codexMode = options.codexMode || "desktop";
    this.usesDesktopOwner = !options.codex && this.codexMode === "desktop";
    this.initialVoiceThreadId = options.voiceThreadId;
    this.voiceThreadIdResolver = options.voiceThreadIdResolver;
    this.codex = options.codex || codexClientForOptions(options, this.log);
    this.devices = options.devices || new DeviceServer({
      host: options.host,
      port: options.port,
      token: options.token,
      log: this.log,
    });
    this.snapshot = options.snapshot || new SnapshotState();
    this.desktopSession = options.desktopSession ||
      (options.desktopSessionLog
        // Match Desktop's cross-project chat list. Only an embedding that
        // explicitly supplies cwd should scope passive activity/approvals.
        ? new DesktopSessionLogFollower({ path: options.desktopSessionLog, cwd: options.cwd || "" })
        : null);
    this.desktopApprovals = options.desktopApprovals || new DesktopApprovalController(
      options.desktopApprovalOptions,
    );
    this.voice = options.voice || new VoiceController({
      codex: this.codex,
      cwd: options.cwd,
      transcriptTimeoutMs: options.voiceTranscriptTimeoutMs,
      threadId: options.voiceThreadId,
      resolveThreadId: options.voiceThreadIdResolver,
      model: options.voiceModel,
      prewarm: options.voicePrewarm !== false,
      realtimeLogger: (diagnostic) => {
        this.log(`realtime ${JSON.stringify(diagnostic)}`);
      },
    });
    this.voiceSessionTimeoutMs = positiveNumber(
      options.voiceSessionTimeoutMs,
      DEFAULT_VOICE_SESSION_TIMEOUT_MS,
    );
    this.voiceMaxPcmBytes = Math.min(
      positiveNumber(options.voiceMaxPcmBytes, VOICE_MAX_PCM_BYTES),
      VOICE_MAX_PCM_BYTES,
    );
    this.voiceUdpReorderWindow = boundedInteger(
      options.voiceUdpReorderWindow,
      DEFAULT_VOICE_UDP_REORDER_WINDOW,
      1,
      32,
    );
    this.voiceUdpStopGraceMs = boundedInteger(
      options.voiceUdpStopGraceMs,
      DEFAULT_VOICE_UDP_STOP_GRACE_MS,
      0,
      1_000,
    );
    this.assistantDeltaIntervalMs = positiveNumber(
      options.assistantDeltaIntervalMs,
      DEFAULT_ASSISTANT_DELTA_INTERVAL_MS,
    );
    this.assistantReplayMs = positiveNumber(
      options.assistantReplayMs,
      DEFAULT_ASSISTANT_REPLAY_MS,
    );
    this.assistantStreamTimeoutMs = positiveNumber(
      options.assistantStreamTimeoutMs,
      DEFAULT_ASSISTANT_STREAM_TIMEOUT_MS,
    );
    this.voiceSessions = new Map();
    this.assistantStreams = new Map();
    this.recentAssistantCompleted = null;
    this.deviceConnections = new Map();
    this.retiredConnections = new WeakSet();
    this.desktopApprovalActions = new Map();
    this.appServerApprovalActions = new Map();
    this.timers = [];
  }

  async start() {
    this.#wireCodex();
    this.#wireDevices();
    this.#wireDesktopSession();

    this.codex.start();
    const init = await this.codex.initialize();
    this.log(`codex app-server: ${init.userAgent || "initialized"}`);

    if (this.usesDesktopOwner) {
      const threadId = this.initialVoiceThreadId || await this.voiceThreadIdResolver?.();
      if (threadId) {
        await this.codex.request("thread/resume", { threadId });
        this.log(`codex Desktop task owner: ${threadId}`);
      }
    }

    await this.devices.start();
    this.log(`device TCP/UDP server: ${this.devices.host}:${this.devices.port}`);
    this.log(`host IPs: ${hostIps().join(", ") || "127.0.0.1"}`);

    await this.refreshThreads();
    this.broadcastSnapshot();
    this.timers.push(setInterval(() => this.refreshThreads().catch((error) => this.log(`thread poll failed: ${error.message}`)), this.pollMs));
    this.timers.push(setInterval(() => this.broadcastSnapshot(), this.heartbeatMs));
    this.timers.push(setInterval(() => {
      if (this.voiceSessions.size === 0) this.devices.broadcast({ cmd: "status" });
    }, 5000));
    await this.desktopSession?.start();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const connection of this.voiceSessions.keys()) this.#clearVoiceSession(connection);
    this.#clearAssistantStreams();
    this.recentAssistantCompleted = null;
    this.desktopSession?.stop();
    this.voice.stop?.();
    this.devices.stop();
    this.codex.stop();
    this.deviceConnections.clear();
    this.appServerApprovalActions.clear();
  }

  async refreshThreads() {
    const result = await this.codex.request("thread/list", {
      limit: 25,
      useStateDbOnly: true,
      archived: false,
    });
    this.snapshot.applyThreadList(result?.data || []);
    this.broadcastSnapshot();
  }

  broadcastSnapshot() {
    // Non-urgent snapshots must not queue ahead of a voice handshake or live
    // transcript on the ESP32's small receive path.
    if (this.voiceSessions.size > 0) return;
    this.devices.broadcast(this.snapshot.toSnapshot());
  }

  #wireCodex() {
    this.codex.on("notification", (message) => {
      if (message?.method === "serverRequest/resolved") {
        if (this.snapshot.resolveApprovalForRequestId?.(message.params?.requestId)) {
          this.broadcastSnapshot();
        }
        return;
      }
      if (message?.method === "item/agentMessage/delta") {
        this.#handleAssistantDelta(message.params);
        return;
      }
      this.snapshot.applyNotification(message);
      this.broadcastSnapshot();
      if (message?.method === "item/completed") {
        this.#handleAssistantCompleted(message.params);
      } else if (message?.method === "turn/completed") {
        this.#completeAssistantTurn(message.params);
      }
    });
    this.codex.on("serverRequest", (request) => this.#handleServerRequest(request));
    this.codex.on("stderr", (line) => {
      if (/ERROR|WARN|error|warn/.test(line)) this.log(`codex: ${line}`);
    });
    this.codex.on("protocolError", (error) => {
      this.log(`codex Desktop IPC failed closed: ${error.message}`);
    });
    this.codex.on("exit", ({ code, signal }) => {
      // The normal item/turn completion events cannot arrive after the
      // app-server exits. Close active device streams with their accumulated
      // text so the HUD does not remain LIVE until its firmware fail-safe.
      for (const [key, stream] of this.assistantStreams) {
        this.#removeAssistantStream(key, stream);
        this.#broadcastAssistantCompleted(stream, stream.text);
      }
      this.log(`codex app-server exited code=${code} signal=${signal}`);
    });
  }

  #handleAssistantDelta(params = {}) {
    const ids = assistantIds(params);
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!ids || (!delta && params.reset !== true)) return;

    const key = assistantStreamKey(ids);
    let stream = this.assistantStreams.get(key);
    if (!stream) {
      stream = {
        ...ids,
        text: "",
        updatedAt: 0,
        lastSentAt: 0,
        lastSentText: "",
        timer: null,
        staleTimer: null,
      };
      this.assistantStreams.set(key, stream);
    }
    stream.text = boundedAssistantAccumulator(params.reset ? delta : stream.text + delta);
    stream.updatedAt = Date.now();
    this.#armAssistantStreamTimeout(key, stream);

    const now = stream.updatedAt;
    const remaining = this.assistantDeltaIntervalMs - (now - stream.lastSentAt);
    if (!stream.lastSentAt || remaining <= 0) {
      if (stream.timer) clearTimeout(stream.timer);
      stream.timer = null;
      this.#broadcastAssistant(stream, "streaming");
      return;
    }
    if (!stream.timer) {
      stream.timer = setTimeout(() => {
        stream.timer = null;
        if (this.assistantStreams.get(key) !== stream) return;
        this.#broadcastAssistant(stream, "streaming");
      }, remaining);
      stream.timer.unref?.();
    }
  }

  #handleAssistantCompleted(params = {}) {
    const item = params.item;
    if (item?.type !== "agentMessage") return;
    const ids = assistantIds(params, item);
    if (!ids) return;

    const key = assistantStreamKey(ids);
    const stream = this.assistantStreams.get(key);
    if (stream) this.#removeAssistantStream(key, stream);
    this.#broadcastAssistantCompleted(
      ids,
      item.text || stream?.text,
      item.phase,
    );
  }

  #completeAssistantTurn(params = {}) {
    const threadId = idString(params.threadId);
    const turnId = idString(params.turnId ?? params.turn?.id);
    if (!turnId) return;

    for (const [key, stream] of this.assistantStreams) {
      if (stream.turnId !== turnId || (threadId && stream.threadId !== threadId)) continue;
      // item/completed is normally authoritative and arrives first. If it did
      // not, preserve the last coalesced delta and still release the device UI.
      this.#removeAssistantStream(key, stream);
      this.#broadcastAssistantCompleted(stream, stream.text, "final_answer");
    }
  }

  #broadcastAssistant(stream, state) {
    const frame = assistantFrame(stream, state, stream.text);
    if (state === "streaming" && frame.text === stream.lastSentText) return;
    stream.lastSentAt = Date.now();
    stream.lastSentText = frame.text;
    this.devices.broadcast(frame);
  }

  #broadcastAssistantCompleted(ids, text, phase) {
    const frame = assistantFrame(ids, "completed", text, phase);
    this.devices.broadcast(frame);
    this.recentAssistantCompleted = {
      frame,
      expiresAt: Date.now() + this.assistantReplayMs,
    };
  }

  #replayAssistant(connection) {
    const now = Date.now();
    if (this.recentAssistantCompleted?.expiresAt > now) {
      connection.send(this.recentAssistantCompleted.frame);
    } else {
      this.recentAssistantCompleted = null;
    }
    // A reconnect can occur between deltas. Send current cumulative previews
    // after the recent completion so an active stream remains the visible one.
    const streams = [...this.assistantStreams.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const stream of streams) {
      const frame = assistantFrame(stream, "streaming", stream.text);
      if (frame.text) connection.send(frame);
    }
  }

  #removeAssistantStream(key, stream) {
    if (stream.timer) clearTimeout(stream.timer);
    if (stream.staleTimer) clearTimeout(stream.staleTimer);
    stream.timer = null;
    stream.staleTimer = null;
    if (this.assistantStreams.get(key) === stream) this.assistantStreams.delete(key);
  }

  #armAssistantStreamTimeout(key, stream) {
    if (stream.staleTimer) clearTimeout(stream.staleTimer);
    stream.staleTimer = setTimeout(() => {
      if (this.assistantStreams.get(key) !== stream) return;
      this.#removeAssistantStream(key, stream);
      this.#broadcastAssistantCompleted(stream, stream.text);
    }, this.assistantStreamTimeoutMs);
    stream.staleTimer.unref?.();
  }

  #clearAssistantStreams() {
    for (const [key, stream] of this.assistantStreams) {
      this.#removeAssistantStream(key, stream);
    }
  }

  #wireDevices() {
    this.devices.on("authenticated", (connection) => {
      const previous = this.deviceConnections.get(connection.name);
      let cancelledSession;
      if (previous && previous !== connection) {
        cancelledSession = this.voiceSessions.get(previous)?.id;
        this.retiredConnections.add(previous);
        this.#clearVoiceSession(previous);
        if (typeof previous.terminate === "function") previous.terminate();
        else previous.close?.();
        this.log(`device ${connection.name} replaced a stale connection`);
      }
      this.deviceConnections.set(connection.name, connection);
      this.log(`device connected: ${connection.name}`);
      connection.send(timeSyncPayload());
      connection.send({ cmd: "owner", name: this.owner });
      connection.send(this.snapshot.toSnapshot());
      if (cancelledSession) {
        connection.send({
          ack: "voice",
          ok: true,
          state: "cancelled",
          session: cancelledSession,
        });
      }
      this.#replayAssistant(connection);
    });
    this.devices.on("disconnect", (connection) => {
      this.#clearVoiceSession(connection);
      if (this.deviceConnections.get(connection.name) === connection) {
        this.deviceConnections.delete(connection.name);
      }
      this.log(`device disconnected: ${connection.name}`);
    });
    this.devices.on("message", (message, connection) => this.#handleDeviceMessage(message, connection));
    this.devices.on("datagram", (datagram, rinfo) =>
      this.#handleVoiceDatagram(datagram, rinfo));
    this.devices.on("deviceError", (error) => this.log(`device error: ${error.message}`));
  }

  #wireDesktopSession() {
    if (!this.desktopSession) return;
    this.desktopSession.on("log", (filePath) => this.log(`desktop session log: ${filePath}`));
    this.desktopSession.on("event", (event) => {
      if (this.snapshot.applySessionLogEvent(event)) {
        for (const promptId of this.desktopApprovalActions.keys()) {
          if (!this.snapshot.approvalFor(promptId)) this.desktopApprovalActions.delete(promptId);
        }
        this.broadcastSnapshot();
      }
    });
    this.desktopSession.on("error", (error) => this.log(`desktop session log error: ${error.message}`));
  }

  #handleServerRequest(request) {
    if (!isApprovalMethod(request.method)) {
      this.log(`auto-empty response for unsupported server request ${request.method}`);
      this.codex.respond(request.id, {});
      return;
    }

    const prompt = this.snapshot.addApproval(request);
    this.log(`approval requested: ${prompt.tool} ${prompt.hint}`);
    this.broadcastSnapshot();
  }

  #handleDeviceMessage(message, connection) {
    if (this.retiredConnections.has(connection)) {
      this.log(`ignored message from retired device connection ${connection.name}`);
      return;
    }
    if (message.cmd === "permission") {
      void this.#handlePermissionMessage(message, connection);
      return;
    }

    if (message.cmd === "voice") {
      this.#handleVoiceControl(message, connection);
      return;
    }

    if (message.cmd === "voice_audio") {
      this.#handleVoiceAudio(message, connection);
      return;
    }

    if (message.ack) {
      return;
    }

    if (message.cmd === "status") {
      connection.send({ ack: "status", ok: true, data: { bridge: true, devices: this.devices.connectedCount } });
    }
  }

  async #handlePermissionMessage(message, connection) {
    if (message.decision !== "once" && message.decision !== "deny") {
      connection.send({ ack: "permission", ok: false, error: "invalid permission decision" });
      return;
    }

    const approval = this.snapshot.approvalFor(message.id);
    if (!approval) {
      connection.send({ ack: "permission", ok: false, error: "unknown prompt id" });
      this.broadcastSnapshot();
      return;
    }

    const decision = message.decision === "deny" ? "decline" : "accept";
    if (approval.source === "desktop-session-log") {
      let action = this.desktopApprovalActions.get(message.id);
      let createdAction = false;
      try {
        if (action && action.deviceDecision !== message.decision) {
          throw new Error("a different decision was already submitted for this Desktop approval");
        }
        if (!action) {
          if (this.snapshot.desktopApprovalCount() !== 1) {
            throw new Error("cannot safely act on multiple Desktop approvals");
          }
          const promise = Promise.resolve().then(() => this.desktopApprovals.respond(
            message.decision === "deny" ? "deny" : "once",
            {
              threadId: desktopThreadId(approval.threadId),
              ...approval.desktopCorrelation,
            },
          ));
          action = { deviceDecision: message.decision, promise };
          this.desktopApprovalActions.set(message.id, action);
          createdAction = true;
        }
        await action.promise;
        connection.send({ ack: "permission", ok: true });
        // The Desktop IPC response only acknowledges the decision dispatch.
        // Keep the prompt correlated by call_id until session-log output
        // confirms that Codex accepted or rejected it.
        this.log(`device ${connection.name} sent Desktop ${decision} for ${approval.tool}`);
      } catch (error) {
        if (
          createdAction
          && !error?.desktopDecisionDispatched
          && this.desktopApprovalActions.get(message.id) === action
        ) {
          this.desktopApprovalActions.delete(message.id);
        }
        connection.send({ ack: "permission", ok: false, error: error.message });
        this.log(`desktop approval ${decision} failed: ${error.message}`);
        this.broadcastSnapshot();
      }
      return;
    }

    let action = this.appServerApprovalActions.get(message.id);
    let createdAction = false;
    try {
      if (action && action.deviceDecision !== message.decision) {
        throw new Error("a different decision was already submitted for this approval");
      }
      if (!action) {
        action = {
          deviceDecision: message.decision,
          promise: Promise.resolve().then(() =>
            this.codex.respond(approval.request.id, { decision })),
        };
        this.appServerApprovalActions.set(message.id, action);
        createdAction = true;
      }
      // Desktop-owner decisions are request/response operations, unlike the
      // fire-and-forget JSON-RPC response used by a private app-server. Do not
      // clear the card or acknowledge the button press until the task owner
      // confirms that it handled the decision.
      await action.promise;
      this.snapshot.resolveApproval(message.id);
      this.appServerApprovalActions.delete(message.id);
      connection.send({ ack: "permission", ok: true });
      this.log(`device ${connection.name} ${decision}ed ${approval.tool}`);
    } catch (error) {
      if (createdAction && this.appServerApprovalActions.get(message.id) === action) {
        this.appServerApprovalActions.delete(message.id);
      }
      connection.send({ ack: "permission", ok: false, error: error.message });
      this.log(`approval ${decision} failed: ${error.message}`);
    }
    this.broadcastSnapshot();
  }

  #handleVoiceControl(message, connection) {
    if (!this.#acceptsDeviceAudio(connection, message, "voice")) return;

    if (message.action === "start") {
      this.#startVoiceSession(message, connection);
      return;
    }
    if (message.action === "stop") {
      this.#requestVoiceStop(message, connection);
      return;
    }
    if (message.action === "cancel") {
      this.#cancelVoiceSession(message, connection);
      return;
    }

    this.#sendVoiceError(
      connection,
      "voice action must be start, stop, or cancel; Mac microphone capture is not supported",
      message.session,
    );
  }

  #startVoiceSession(message, connection) {
    const receivedAt = performance.now();
    if (!isVoiceSessionId(message.session)) {
      this.#sendVoiceError(connection, "voice session must be a hexadecimal id", message.session);
      return;
    }
    const channels = message.channels ?? message.numChannels;
    const conflictingChannels = message.channels !== undefined &&
      message.numChannels !== undefined && message.channels !== message.numChannels;
    const transport = message.transport ?? "wifi";
    if (transport !== "wifi" && transport !== "wifi_udp") {
      this.#sendVoiceError(
        connection,
        "voice audio transport must be wifi or wifi_udp",
        message.session,
      );
      return;
    }
    const validSampleRate = message.sampleRate === VOICE_REALTIME_SAMPLE_RATE ||
      message.sampleRate === VOICE_WIFI_UDP_SAMPLE_RATE;
    if (
      !validSampleRate ||
      channels !== VOICE_NUM_CHANNELS ||
      conflictingChannels ||
      message.format !== VOICE_FORMAT
    ) {
      const supportedRates = `${VOICE_WIFI_UDP_SAMPLE_RATE} or ${VOICE_REALTIME_SAMPLE_RATE}`;
      this.#sendVoiceError(
        connection,
        `voice audio must be ${supportedRates} Hz ${VOICE_FORMAT} mono`,
        message.session,
      );
      return;
    }
    if (transport === "wifi_udp" && !/^[0-9a-f]{8}$/i.test(message.session)) {
      this.#sendVoiceError(
        connection,
        "UDP voice session must be an 8-character hexadecimal id",
        message.session,
      );
      return;
    }
    const existing = this.voiceSessions.get(connection);
    if (existing?.id === message.session) {
      if (
        existing.transport !== transport ||
        existing.sourceSampleRate !== message.sampleRate
      ) {
        this.#sendVoiceError(
          connection,
          `voice session audio is already ${existing.sourceSampleRate} Hz over ` +
          existing.transport,
          message.session,
        );
        return;
      }
      const preview = previewTranscript(existing.transcript);
      connection.send({
        ack: "voice",
        ok: true,
        state: existing.status,
        session: existing.id,
        ...(preview ? { text: preview } : {}),
      });
      this.log(
        `device ${connection.name} voice start replay ACK: ` +
        `latency=${(performance.now() - receivedAt).toFixed(1)}ms`,
      );
      return;
    }
    if (existing?.status === "recording") {
      this.log(
        `device ${connection.name} replaced abandoned voice session ` +
        `${existing.id} with ${message.session}`,
      );
      this.#clearVoiceSession(connection);
    } else if (existing) {
      this.#sendVoiceError(
        connection,
        "the previous voice session is still transcribing",
        message.session,
        { expectedSession: existing.id },
      );
      return;
    }

    let transcriber;
    let session;
    try {
      if (typeof this.voice.beginPcmAudio !== "function") {
        throw new Error("voice controller does not support realtime device audio");
      }
      // This opens the OpenAI Realtime connection and resolves the Codex target
      // while the user is still speaking. Audio frames can arrive immediately;
      // the transport queues them until its WebSocket is ready.
      transcriber = this.voice.beginPcmAudio({
        sampleRate: VOICE_REALTIME_SAMPLE_RATE,
        numChannels: VOICE_NUM_CHANNELS,
        submit: true,
        onDelta: (delta) => this.#onVoiceDelta(connection, session, delta),
        onFinalTranscript: (transcript) =>
          this.#onFinalVoiceTranscript(connection, session, transcript),
      });
    } catch (error) {
      this.#sendVoiceError(connection, error.message, message.session);
      return;
    }

    session = {
      id: message.session,
      transport,
      sourceSampleRate: message.sampleRate,
      status: "recording",
      transcriber,
      sourceBytes: 0,
      sourceSamples: 0,
      realtimeBytes: 0,
      resampler: message.sampleRate === VOICE_REALTIME_SAMPLE_RATE
        ? null
        : new StreamingPcm16MonoResampler(
            message.sampleRate,
            VOICE_REALTIME_SAMPLE_RATE,
          ),
      maxSourcePcmBytes: Math.min(
        this.voiceMaxPcmBytes,
        message.sampleRate * VOICE_BYTES_PER_SAMPLE * VOICE_MAX_SECONDS,
      ),
      nextSeq: 0,
      udpPending: new Map(),
      udpPendingBytes: 0,
      udpStopWait: null,
      stopPromise: null,
      level: emptyPcm16Level(),
      timer: null,
      deltaTimer: null,
      transcript: "",
      startedAt: Date.now(),
      timelineStartedAt: receivedAt,
      acknowledgedAt: 0,
      firstAudioAt: 0,
      commitStartedAt: 0,
      firstDeltaAt: 0,
      lastDeltaSentAt: 0,
    };
    session.timer = setTimeout(() => {
      if (this.voiceSessions.get(connection) !== session) return;
      this.#clearVoiceSession(connection);
      this.#sendVoiceError(connection, "voice capture timed out", session.id);
      this.snapshot.addEntry("voice failed capture timed out");
      this.log(`device ${connection.name} voice capture timed out`);
      this.broadcastSnapshot();
    }, this.voiceSessionTimeoutMs);
    session.timer.unref?.();
    this.voiceSessions.set(connection, session);

    connection.send({
      ack: "voice",
      ok: true,
      state: "recording",
      session: session.id,
    });
    session.acknowledgedAt = performance.now();
    this.log(
      `device ${connection.name} voice start ACK: ` +
      `latency=${(session.acknowledgedAt - session.timelineStartedAt).toFixed(1)}ms`,
    );
    this.snapshot.addEntry("voice streaming device audio");
  }

  #requestVoiceStop(message, connection) {
    const session = this.voiceSessions.get(connection);
    if (session?.stopPromise) {
      if (message.session !== session.id) {
        this.#sendVoiceError(
          connection,
          "the previous voice session is still transcribing",
          message.session,
          { expectedSession: session.id },
        );
        return;
      }
      const preview = previewTranscript(session.transcript);
      connection.send({
        ack: "voice",
        ok: true,
        state: session.status,
        session: session.id,
        ...(preview ? { text: preview } : {}),
      });
      return;
    }

    const stopPromise = this.#stopVoiceSession(message, connection);
    if (!session || this.voiceSessions.get(connection) !== session) {
      void stopPromise;
      return;
    }
    session.stopPromise = stopPromise;
    void stopPromise.then(
      () => {
        if (session.stopPromise === stopPromise) session.stopPromise = null;
      },
      (error) => {
        if (session.stopPromise === stopPromise) session.stopPromise = null;
        this.log(`voice stop failed unexpectedly: ${error.message}`);
      },
    );
  }

  #handleVoiceAudio(message, connection) {
    if (!this.#acceptsDeviceAudio(connection, message, "voice_audio")) return;
    const session = this.voiceSessions.get(connection);
    if (!session || session.status !== "recording") {
      this.#sendVoiceAudioError(connection, message, "no active voice recording");
      return;
    }
    if (session.transport !== "wifi") {
      this.#sendVoiceAudioError(connection, message, "voice session expects UDP audio");
      return;
    }
    if (message.session !== session.id) {
      this.#sendVoiceAudioError(connection, message, "voice session id does not match");
      return;
    }
    if (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq !== session.nextSeq) {
      this.#sendVoiceAudioError(
        connection,
        message,
        `voice audio sequence must be ${session.nextSeq}`,
        session.nextSeq,
      );
      return;
    }
    if (message.encoding !== "base64") {
      this.#sendVoiceAudioError(connection, message, "voice audio encoding must be base64");
      return;
    }

    let chunk;
    try {
      chunk = decodeVoicePcmChunk(message.data);
    } catch (error) {
      this.#sendVoiceAudioError(connection, message, error.message);
      return;
    }
    try {
      this.#appendVoicePcm(connection, session, chunk, message.data);
    } catch (error) {
      this.#sendVoiceAudioError(connection, message, error.message);
      return;
    }
  }

  #handleVoiceDatagram(datagram, rinfo = {}) {
    if (
      !datagram ||
      !/^[0-9a-f]{8}$/i.test(datagram.session || "") ||
      !Number.isSafeInteger(datagram.seq) ||
      datagram.seq < 0 ||
      !Buffer.isBuffer(datagram.pcm) ||
      datagram.pcm.length === 0 ||
      datagram.pcm.length > VOICE_MAX_UDP_CHUNK_BYTES ||
      datagram.pcm.length % VOICE_BYTES_PER_SAMPLE !== 0
    ) {
      return;
    }

    const sourceAddress = normalizeIpAddress(rinfo.address);
    if (!sourceAddress) return;
    let matched = null;
    for (const [connection, session] of this.voiceSessions) {
      if (
        connection.authenticated !== true ||
        session.transport !== "wifi_udp" ||
        session.status !== "recording" ||
        session.id.toLowerCase() !== datagram.session.toLowerCase() ||
        normalizeIpAddress(connection.remoteAddress ?? connection.socket?.remoteAddress) !==
          sourceAddress
      ) {
        continue;
      }
      // A session id and source address must identify one authenticated TCP
      // control connection. An ambiguous packet is safer to drop than route.
      if (matched) return;
      matched = { connection, session };
    }
    if (!matched) return;

    const { connection, session } = matched;
    if (datagram.seq < session.nextSeq || session.udpPending.has(datagram.seq)) return;
    if (datagram.seq - session.nextSeq >= this.voiceUdpReorderWindow) return;
    if (
      session.sourceBytes + session.udpPendingBytes + datagram.pcm.length >
      session.maxSourcePcmBytes
    ) {
      this.#failVoiceDatagram(
        connection,
        session,
        datagram.seq,
        "voice audio exceeds the 30 second limit",
      );
      return;
    }

    const chunk = Buffer.from(datagram.pcm);
    session.udpPending.set(datagram.seq, chunk);
    session.udpPendingBytes += chunk.length;
    while (session.udpPending.has(session.nextSeq)) {
      const ordered = session.udpPending.get(session.nextSeq);
      session.udpPending.delete(session.nextSeq);
      session.udpPendingBytes -= ordered.length;
      try {
        // Raw PCM crosses the LAN. Base64 exists only at this Mac-to-Realtime
        // boundary because the OpenAI client transport expects it.
        this.#appendVoicePcm(connection, session, ordered, ordered.toString("base64"));
      } catch (error) {
        this.#failVoiceDatagram(connection, session, datagram.seq, error.message);
        return;
      }
    }
    this.#resolveUdpStopWait(session);
  }

  #appendVoicePcm(connection, session, chunk, base64) {
    if (session.sourceBytes + chunk.length > session.maxSourcePcmBytes) {
      throw new Error("voice audio exceeds the 30 second limit");
    }
    const realtimeChunk = session.resampler?.append(chunk) ?? chunk;
    const realtimeBase64 = realtimeChunk === chunk
      ? base64
      : realtimeChunk.toString("base64");
    if (realtimeChunk.length > 0) {
      session.transcriber.appendBase64(realtimeBase64, realtimeChunk.length);
    }
    addPcm16Level(session.level, chunk);
    session.sourceBytes += chunk.length;
    session.sourceSamples += chunk.length / VOICE_BYTES_PER_SAMPLE;
    session.realtimeBytes += realtimeChunk.length;
    session.nextSeq += 1;
    if (!session.firstAudioAt) {
      session.firstAudioAt = performance.now();
      this.log(
        `device ${connection.name} voice first PCM: ` +
        `latency=${(session.firstAudioAt - session.timelineStartedAt).toFixed(1)}ms, ` +
        `after_ack=${(session.firstAudioAt - session.acknowledgedAt).toFixed(1)}ms`,
      );
    }
  }

  #failVoiceDatagram(connection, session, seq, error) {
    if (this.voiceSessions.get(connection) === session) this.#clearVoiceSession(connection);
    connection.send({
      ack: "voice_audio",
      ok: false,
      session: session.id,
      seq,
      error,
    });
  }

  async #stopVoiceSession(message, connection) {
    if (!this.#acceptsDeviceAudio(connection, message, "voice")) return;
    const session = this.voiceSessions.get(connection);
    if (!session) {
      this.#sendVoiceError(connection, "no active voice recording", message.session);
      return;
    }
    if (session.status !== "recording") {
      if (message.session === session.id) {
        const preview = previewTranscript(session.transcript);
        connection.send({
          ack: "voice",
          ok: true,
          state: session.status === "transcribed" ? "transcribed" : "transcribing",
          session: session.id,
          ...(preview ? { text: preview } : {}),
        });
      } else {
        this.#sendVoiceError(
          connection,
          "the previous voice session is still transcribing",
          message.session,
          { expectedSession: session.id },
        );
      }
      return;
    }
    if (message.session !== session.id) {
      const expectedSession = session.id;
      this.#clearVoiceSession(connection);
      this.#sendVoiceError(
        connection,
        "voice session id does not match; recording reset",
        message.session,
        { expectedSession },
      );
      return;
    }
    if (
      session.transport === "wifi_udp" &&
      Number.isSafeInteger(message.seq) &&
      message.seq > session.nextSeq
    ) {
      await this.#waitForUdpSequence(session, message.seq);
      if (
        this.voiceSessions.get(connection) !== session ||
        session.status !== "recording"
      ) {
        return;
      }
    }
    if (!Number.isSafeInteger(message.seq) || message.seq !== session.nextSeq) {
      const expectedSeq = session.nextSeq;
      this.#clearVoiceSession(connection);
      this.#sendVoiceError(
        connection,
        `voice stop sequence must be ${expectedSeq}; recording reset`,
        session.id,
        { expectedSeq },
      );
      return;
    }
    const expectedSamples = session.sourceSamples;
    if (!Number.isSafeInteger(message.samples) || message.samples !== expectedSamples || expectedSamples === 0) {
      this.#clearVoiceSession(connection);
      this.#sendVoiceError(
        connection,
        `voice sample count must be ${expectedSamples}; recording reset`,
        session.id,
        { expectedSamples },
      );
      return;
    }

    try {
      const realtimeTail = session.resampler?.finish() ?? Buffer.alloc(0);
      if (realtimeTail.length > 0) {
        session.transcriber.appendBase64(
          realtimeTail.toString("base64"),
          realtimeTail.length,
        );
        session.realtimeBytes += realtimeTail.length;
      }
    } catch (error) {
      this.#clearVoiceSession(connection);
      this.#sendVoiceError(connection, error.message, session.id);
      return;
    }

    session.status = "transcribing";
    session.udpPending.clear();
    session.udpPendingBytes = 0;
    session.commitStartedAt = Date.now();
    clearTimeout(session.timer);
    session.timer = null;
    if (session.deltaTimer) clearTimeout(session.deltaTimer);
    session.deltaTimer = null;
    const audioLevel = finishPcm16Level(session.level);
    const stoppedAt = performance.now();
    const pcmMs = session.sourceSamples * 1000 / session.sourceSampleRate;
    this.log(
      `device ${connection.name} voice stop: ` +
      `wall=${(stoppedAt - session.timelineStartedAt).toFixed(1)}ms, ` +
      `pcm=${pcmMs.toFixed(1)}ms, source_rate=${session.sourceSampleRate}Hz, ` +
      `samples=${session.sourceSamples}, bytes=${session.sourceBytes}, ` +
      `realtime_bytes=${session.realtimeBytes}, chunks=${session.nextSeq}, ` +
      `rms=${audioLevel.rms}, peak=${audioLevel.peak}`,
    );
    const preview = previewTranscript(session.transcript);
    connection.send({
      ack: "voice",
      ok: true,
      state: "transcribing",
      session: session.id,
      ...(preview ? { text: preview } : {}),
    });
    this.snapshot.addEntry("voice finalizing live transcript");

    try {
      const result = await session.transcriber.finish();
      if (this.voiceSessions.get(connection) !== session) return;
      const finalPreview = previewTranscript(result.transcript);
      connection.send({
        ack: "voice",
        ok: true,
        state: "submitted",
        session: session.id,
        text: finalPreview,
        submitted: result.submitted,
        threadId: result.threadId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(result.turnStatus ? { turnStatus: result.turnStatus } : {}),
      });
      this.snapshot.addEntry(`voice ${result.submitted ? "sent" : "heard"} ${result.transcript}`);
      this.log(
        `device ${connection.name} voice submitted in ` +
        `${Date.now() - session.startedAt}ms ` +
        `(${Date.now() - session.commitStartedAt}ms after release) ` +
        `to task ${result.threadId}: ${result.transcript}`,
      );
    } catch (error) {
      if (this.voiceSessions.get(connection) !== session) return;
      const deviceError = voiceErrorForDevice(error);
      this.#sendVoiceError(connection, deviceError, session.id);
      this.snapshot.addEntry(`voice failed ${error.message}`);
      this.log(
        `voice failed ${Date.now() - session.commitStartedAt}ms after release: ${error.message}`,
      );
    } finally {
      if (this.voiceSessions.get(connection) === session) this.#clearVoiceSession(connection);
      this.broadcastSnapshot();
    }
  }

  #waitForUdpSequence(session, expectedSeq) {
    if (session.nextSeq >= expectedSeq || this.voiceUdpStopGraceMs === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wait = {
        expectedSeq,
        timer: null,
        finish: null,
      };
      wait.finish = () => {
        if (session.udpStopWait !== wait) return;
        session.udpStopWait = null;
        if (wait.timer) clearTimeout(wait.timer);
        resolve();
      };
      wait.timer = setTimeout(wait.finish, this.voiceUdpStopGraceMs);
      wait.timer.unref?.();
      session.udpStopWait = wait;
      this.#resolveUdpStopWait(session);
    });
  }

  #resolveUdpStopWait(session, force = false) {
    const wait = session?.udpStopWait;
    if (!wait) return;
    if (force || session.nextSeq >= wait.expectedSeq) wait.finish();
  }

  #cancelVoiceSession(message, connection) {
    if (!isVoiceSessionId(message.session)) {
      this.#sendVoiceError(connection, "voice session must be a hexadecimal id", message.session);
      return;
    }
    const session = this.voiceSessions.get(connection);
    if (session?.id === message.session) {
      this.#clearVoiceSession(connection);
      this.snapshot.addEntry("voice capture cancelled");
    }
    // Cancellation is idempotent. In particular, a late cancel for an old
    // session must not tear down a newer recording on the same connection.
    connection.send({
      ack: "voice",
      ok: true,
      state: "cancelled",
      session: message.session,
    });
  }

  #onVoiceDelta(connection, session, delta) {
    if (!session || this.voiceSessions.get(connection) !== session) return;
    if (session.status !== "recording" && session.status !== "transcribing") return;
    const text = String(delta ?? "");
    if (!text) return;
    session.transcript += text;

    const now = Date.now();
    if (!session.firstDeltaAt) {
      session.firstDeltaAt = now;
      this.log(
        `device ${connection.name} first live transcript in ` +
        `${now - session.startedAt}ms`,
      );
    }
    const remaining = VOICE_DELTA_INTERVAL_MS - (now - session.lastDeltaSentAt);
    if (!session.lastDeltaSentAt || remaining <= 0) {
      this.#sendVoicePartial(connection, session);
      return;
    }
    if (!session.deltaTimer) {
      session.deltaTimer = setTimeout(() => {
        session.deltaTimer = null;
        this.#sendVoicePartial(connection, session);
      }, remaining);
      session.deltaTimer.unref?.();
    }
  }

  #onFinalVoiceTranscript(connection, session, transcript) {
    if (!session || this.voiceSessions.get(connection) !== session) return;
    if (session.status !== "transcribing") return;

    if (session.deltaTimer) clearTimeout(session.deltaTimer);
    session.deltaTimer = null;
    session.transcript = String(transcript ?? "");
    session.status = "transcribed";

    const preview = previewTranscript(session.transcript);
    connection.send({
      ack: "voice",
      ok: true,
      state: "transcribed",
      session: session.id,
      text: preview,
      submitted: false,
    });
    this.log(
      `device ${connection.name} final voice transcript ready ` +
      `${Date.now() - session.commitStartedAt}ms after release`,
    );
  }

  #sendVoicePartial(connection, session) {
    if (this.voiceSessions.get(connection) !== session) return;
    if (session.status !== "recording" && session.status !== "transcribing") return;
    const preview = previewTranscript(session.transcript);
    if (!preview) return;
    session.lastDeltaSentAt = Date.now();
    connection.send({
      ack: "voice",
      ok: true,
      state: session.status,
      session: session.id,
      text: preview,
    });
  }

  #acceptsDeviceAudio(connection, message, ack) {
    if (connection?.authenticated !== true) {
      const payload = { ack, ok: false, error: "device authentication required" };
      if (ack === "voice") payload.state = "error";
      connection?.send(payload);
      return false;
    }
    const suppliesThreadId = ["threadId", "thread_id", "targetThreadId", "voiceThreadId"]
      .some((field) => Object.hasOwn(message, field));
    if (suppliesThreadId) {
      const error = "device-supplied voice thread ids are not allowed";
      if (ack === "voice") this.#sendVoiceError(connection, error, message.session);
      else this.#sendVoiceAudioError(connection, message, error);
      return false;
    }
    return true;
  }

  #sendVoiceError(connection, error, session, details = {}) {
    connection.send({
      ack: "voice",
      ok: false,
      state: "error",
      ...(session ? { session } : {}),
      ...details,
      error,
    });
  }

  #sendVoiceAudioError(connection, message, error, expectedSeq) {
    const active = this.voiceSessions.get(connection);
    const expectedSession = active?.id;
    // Any rejected audio means the two ordered stream state machines have
    // diverged. Reset the recording so the next start can recover immediately.
    if (active) this.#clearVoiceSession(connection);
    connection.send({
      ack: "voice_audio",
      ok: false,
      ...(message?.session ? { session: message.session } : {}),
      ...(Number.isSafeInteger(message?.seq) ? { seq: message.seq } : {}),
      ...(Number.isSafeInteger(expectedSeq) ? { expectedSeq } : {}),
      ...(expectedSession && expectedSession !== message?.session ? { expectedSession } : {}),
      error,
    });
  }

  #clearVoiceSession(connection) {
    const session = this.voiceSessions.get(connection);
    if (!session) return;
    this.voiceSessions.delete(connection);
    if (session.timer) clearTimeout(session.timer);
    if (session.deltaTimer) clearTimeout(session.deltaTimer);
    this.#resolveUdpStopWait(session, true);
    session.udpPending?.clear();
    session.udpPendingBytes = 0;
    try {
      session.transcriber?.abort();
    } catch (error) {
      this.log(`voice cleanup failed: ${error.message}`);
    } finally {
      session.transcriber = null;
    }
  }
}

function codexClientForOptions(options, log) {
  const mode = options.codexMode || "desktop";
  if (mode === "desktop") {
    return new DesktopCodexClient({
      socketPath: options.desktopIpcSocket,
      requestTimeoutMs: options.codexRequestTimeoutMs,
    });
  }
  if (mode !== "private" && mode !== "proxy") {
    throw new Error(`unsupported Codex connection mode: ${mode}`);
  }
  if (mode === "proxy" && !isProxyArgs(options.codexArgs)) {
    throw new Error("Codex proxy mode requires explicit app-server proxy arguments");
  }
  return new CodexJsonRpcClient({
    codexBin: options.codexBin,
    args: options.codexArgs,
    cwd: options.cwd,
    requestTimeoutMs: options.codexRequestTimeoutMs,
    log,
  });
}

function isProxyArgs(args) {
  return Array.isArray(args) && args[0] === "app-server" && args[1] === "proxy";
}

export class StreamingPcm16MonoResampler {
  constructor(sourceSampleRate, targetSampleRate) {
    if (!Number.isSafeInteger(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error("source sample rate must be a positive integer");
    }
    if (!Number.isSafeInteger(targetSampleRate) || targetSampleRate <= 0) {
      throw new Error("target sample rate must be a positive integer");
    }
    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.sourceSamples = 0;
    this.outputSamples = 0;
    this.lastSourceSample = null;
    this.finished = false;
  }

  append(pcm) {
    if (this.finished) throw new Error("cannot append PCM after resampler finish");
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      throw new Error("resampler PCM must be a non-empty Buffer");
    }
    if (pcm.length % VOICE_BYTES_PER_SAMPLE !== 0) {
      throw new Error("resampler PCM must contain complete samples");
    }

    const sourceStart = this.sourceSamples;
    const inputSamples = pcm.length / VOICE_BYTES_PER_SAMPLE;
    const sourceEnd = sourceStart + inputSamples;
    const previousSample = this.lastSourceSample;
    // Only emit samples whose interpolation has both source neighbors. The
    // retained final source sample bridges this chunk to the next datagram.
    const lastAvailableOutput = Math.floor(
      ((sourceEnd - 1) * this.targetSampleRate) / this.sourceSampleRate,
    );
    const outputCount = Math.max(0, lastAvailableOutput - this.outputSamples + 1);
    const output = Buffer.allocUnsafe(outputCount * VOICE_BYTES_PER_SAMPLE);

    const sampleAt = (index) => {
      if (index === sourceStart - 1 && sourceStart > 0) return previousSample;
      if (index < sourceStart || index >= sourceEnd) {
        throw new Error("resampler source continuity was lost");
      }
      return pcm.readInt16LE((index - sourceStart) * VOICE_BYTES_PER_SAMPLE);
    };

    for (let offset = 0; offset < outputCount; offset += 1) {
      const outputIndex = this.outputSamples + offset;
      const sourceNumerator = outputIndex * this.sourceSampleRate;
      const leftIndex = Math.floor(sourceNumerator / this.targetSampleRate);
      const remainder = sourceNumerator - leftIndex * this.targetSampleRate;
      const rightIndex = leftIndex + (remainder === 0 ? 0 : 1);
      const left = sampleAt(leftIndex);
      const right = sampleAt(rightIndex);
      const interpolated = left +
        ((right - left) * remainder) / this.targetSampleRate;
      output.writeInt16LE(Math.round(interpolated), offset * VOICE_BYTES_PER_SAMPLE);
    }

    this.sourceSamples = sourceEnd;
    this.outputSamples += outputCount;
    this.lastSourceSample = pcm.readInt16LE(pcm.length - VOICE_BYTES_PER_SAMPLE);
    return output;
  }

  finish() {
    if (this.finished) return Buffer.alloc(0);
    this.finished = true;
    const targetOutputSamples = Math.floor(
      (this.sourceSamples * this.targetSampleRate) / this.sourceSampleRate,
    );
    const outputCount = Math.max(0, targetOutputSamples - this.outputSamples);
    const output = Buffer.allocUnsafe(outputCount * VOICE_BYTES_PER_SAMPLE);
    for (let offset = 0; offset < outputCount; offset += 1) {
      // A causal stream cannot interpolate beyond its final source sample.
      // Holding that sample fills only the fractional tail needed for the
      // exact rate-derived output length.
      output.writeInt16LE(this.lastSourceSample, offset * VOICE_BYTES_PER_SAMPLE);
    }
    this.outputSamples += outputCount;
    return output;
  }
}

function decodeVoicePcmChunk(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("voice audio data must be non-empty base64");
  }
  const maxEncodedLength = Math.ceil(VOICE_MAX_CHUNK_BYTES / 3) * 4;
  if (value.length > maxEncodedLength) {
    throw new Error(`voice audio chunks must not exceed ${VOICE_MAX_CHUNK_BYTES} bytes`);
  }
  if (value.length % 4 !== 0) throw new Error("voice audio data is invalid base64");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("voice audio data is invalid base64");
  }
  const chunk = Buffer.from(value, "base64");
  if (chunk.length === 0 || chunk.length > VOICE_MAX_CHUNK_BYTES || chunk.toString("base64") !== value) {
    throw new Error("voice audio data is invalid base64");
  }
  if (chunk.length % VOICE_BYTES_PER_SAMPLE !== 0) {
    throw new Error("voice PCM16 chunks must contain complete samples");
  }
  return chunk;
}

function emptyPcm16Level() {
  return { samples: 0, peak: 0, sumSquares: 0 };
}

function addPcm16Level(level, pcm) {
  for (let offset = 0; offset < pcm.length; offset += VOICE_BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(offset);
    const magnitude = Math.abs(sample);
    if (magnitude > level.peak) level.peak = magnitude;
    level.sumSquares += sample * sample;
    level.samples += 1;
  }
}

function finishPcm16Level(level) {
  return {
    samples: level.samples,
    peak: level.peak,
    rms: level.samples > 0 ? Math.round(Math.sqrt(level.sumSquares / level.samples)) : 0,
  };
}

function isVoiceSessionId(value) {
  return typeof value === "string" && /^[0-9a-f]{1,32}$/i.test(value);
}

function previewTranscript(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") <= VOICE_PREVIEW_BYTES) {
    return normalized;
  }

  const prefix = "...";
  let bytes = Buffer.byteLength(prefix, "utf8");
  const suffix = [];
  for (const character of Array.from(normalized).reverse()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > VOICE_PREVIEW_BYTES) break;
    suffix.push(character);
    bytes += characterBytes;
  }
  return prefix + suffix.reverse().join("");
}

function assistantIds(params, item = {}) {
  const threadId = idString(params?.threadId ?? item?.threadId);
  const turnId = idString(params?.turnId ?? params?.turn?.id ?? item?.turnId);
  const itemId = idString(params?.itemId ?? item?.id);
  return threadId && turnId && itemId ? { threadId, turnId, itemId } : null;
}

function assistantStreamKey({ threadId, turnId, itemId }) {
  return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

function assistantFrame(ids, state, text, phase) {
  const frame = {
    cmd: "assistant",
    state,
    threadId: boundedAssistantId(ids.threadId),
    turnId: boundedAssistantId(ids.turnId),
    itemId: boundedAssistantId(ids.itemId),
    text: assistantPreview(text),
  };
  if (phase === "commentary" || phase === "final_answer") frame.phase = phase;

  // The ESP32 receives JSONL into a fixed 1024-byte buffer. Text and IDs come
  // from the app-server, so enforce the serialized limit instead of assuming
  // that a character/UTF-8 limit also bounds JSON escaping.
  while (jsonLineBytes(frame) >= DEVICE_RX_LINE_BYTES && frame.text) {
    const characters = Array.from(
      frame.text.startsWith("...") ? frame.text.slice(3) : frame.text,
    );
    characters.shift();
    frame.text = characters.length > 0 ? `...${characters.join("")}` : "";
  }
  return frame;
}

function assistantPreview(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") <= ASSISTANT_PREVIEW_BYTES) return normalized;

  const prefix = "...";
  let bytes = Buffer.byteLength(prefix, "utf8");
  const suffix = [];
  for (const character of Array.from(normalized).reverse()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > ASSISTANT_PREVIEW_BYTES) break;
    suffix.push(character);
    bytes += characterBytes;
  }
  return prefix + suffix.reverse().join("");
}

function boundedAssistantId(value) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  let bytes = 0;
  let result = "";
  for (const character of Array.from(normalized)) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > ASSISTANT_ID_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function jsonLineBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function boundedAssistantAccumulator(value) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= ASSISTANT_ACCUMULATOR_BYTES) return text;

  let bytes = 0;
  const suffix = [];
  for (const character of Array.from(text).reverse()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > ASSISTANT_ACCUMULATOR_BYTES) break;
    suffix.push(character);
    bytes += characterBytes;
  }
  return suffix.reverse().join("");
}

function idString(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function desktopThreadId(value) {
  const threadId = idString(value);
  return threadId.startsWith("desktop:") ? threadId.slice("desktop:".length) : "";
}

function voiceErrorForDevice(error) {
  if (error?.code === "NO_SPEECH") {
    return "no speech detected - hold A while speaking";
  }
  return String(error?.message || error || "voice transcription failed");
}

function positiveNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeIpAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function timeSyncPayload() {
  const now = Math.floor(Date.now() / 1000);
  const offset = -new Date().getTimezoneOffset() * 60;
  return { time: [now, offset] };
}

export function hostIps() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}
