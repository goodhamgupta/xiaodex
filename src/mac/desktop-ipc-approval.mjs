import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DESKTOP_IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;

const INITIALIZING_CLIENT_ID = "initializing-client";
const INITIALIZE_METHOD = "initialize";
const STREAM_STATE_METHOD = "thread-stream-state-changed";
const STREAM_FOLLOWING_METHOD = "thread-stream-following-changed";
const STREAM_FOLLOWING_STATUS_METHOD = "thread-stream-following-status-requested";
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const COMMAND_APPROVAL_DECISION_METHOD = "thread-follower-command-approval-decision";

const INITIALIZE_VERSION = 0;
const STREAM_FOLLOWING_VERSION = 1;
const STREAM_FOLLOWING_STATUS_VERSION = 1;
const COMMAND_APPROVAL_DECISION_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Verified in the installed Desktop bundles: these versions retain the
// snapshot/patch envelope and turn/approval fields used by both adapters.
export function isSupportedDesktopStreamVersion(version) {
  return version === 11 || version === 13;
}

export function defaultDesktopIpcSocketPath() {
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "ipc", "ipc.sock");
}

export class DesktopIpcApprovalClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || defaultDesktopIpcSocketPath();
    this.clientType = options.clientType || "xiaodex-bridge";
    this.hostId = options.hostId || "local";
    this.timeoutMs = positiveInteger(options.timeoutMs, 5_000, "timeoutMs");
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes,
      DESKTOP_IPC_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );

    if (typeof this.socketPath !== "string" || this.socketPath.trim() === "") {
      throw new TypeError("Desktop IPC socketPath must be a non-empty string");
    }
    if (typeof this.clientType !== "string" || this.clientType.trim() === "") {
      throw new TypeError("Desktop IPC clientType must be a non-empty string");
    }
    if (typeof this.hostId !== "string" || this.hostId.trim() === "") {
      throw new TypeError("Desktop IPC hostId must be a non-empty string");
    }
  }

  async respond(decision, context = {}) {
    const expectedApproval = validateApprovalContext(context);
    const { threadId } = expectedApproval;
    const normalizedDecision = validateDecision(decision);
    const transport = await connectTransport({
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
      maxFrameBytes: this.maxFrameBytes,
    });

    let decisionDispatched = false;
    try {
      const initializeRequestId = randomUUID();
      transport.send({
        type: "request",
        requestId: initializeRequestId,
        sourceClientId: INITIALIZING_CLIENT_ID,
        version: INITIALIZE_VERSION,
        method: INITIALIZE_METHOD,
        params: { clientType: this.clientType },
      });

      const initializeResponse = await this.#waitForResponse(
        transport,
        initializeRequestId,
        "Desktop IPC initialization",
      );
      const clientId = parseInitializeResponse(initializeResponse);

      this.#sendFollowing(transport, {
        clientId,
        threadId,
      });

      const { ownerClientId, approvalRequestId, streamVersion } = await this.#waitForSnapshot(transport, {
        clientId,
        expectedApproval,
        threadId,
      });
      const decisionRequestId = randomUUID();
      transport.send({
        type: "request",
        requestId: decisionRequestId,
        sourceClientId: clientId,
        version: COMMAND_APPROVAL_DECISION_VERSION,
        method: COMMAND_APPROVAL_DECISION_METHOD,
        params: {
          conversationId: threadId,
          requestId: approvalRequestId,
          decision: normalizedDecision,
        },
        targetClientId: ownerClientId,
        timeoutMs: this.timeoutMs,
      });
      decisionDispatched = true;

      const decisionResponse = await this.#waitForDecisionResponse(transport, {
        clientId,
        decisionRequestId,
        ownerClientId,
        streamVersion,
        threadId,
      });
      parseDecisionResponse(decisionResponse, {
        decisionRequestId,
        ownerClientId,
      });

      return {
        conversationId: threadId,
        requestId: approvalRequestId,
        ownerClientId,
        decision: normalizedDecision,
      };
    } catch (error) {
      if (!decisionDispatched) throw error;
      const failure = error instanceof Error ? error : new Error(stringError(error));
      failure.desktopDecisionDispatched = true;
      throw failure;
    } finally {
      transport.close();
    }
  }

  async #waitForResponse(transport, requestId, stage) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const message = await transport.next(remainingMs(deadline, stage), stage);
      if (this.#handleDiscoveryRequest(transport, message)) continue;
      if (message.type !== "response" || message.requestId !== requestId) continue;
      return message;
    }
  }

  async #waitForSnapshot(transport, { clientId, expectedApproval, threadId }) {
    const stage = "Desktop IPC approval snapshot";
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      const message = await transport.next(remainingMs(deadline, stage), stage);
      if (this.#handleDiscoveryRequest(transport, message)) continue;
      if (this.#handleFollowingStatusRequest(transport, message, { clientId, threadId })) {
        continue;
      }
      if (message.type !== "broadcast" || message.method !== STREAM_STATE_METHOD) {
        continue;
      }
      return parseApprovalSnapshot(message, {
        clientId,
        expectedApproval,
        hostId: this.hostId,
        threadId,
      });
    }
  }

  async #waitForDecisionResponse(
    transport,
    { clientId, decisionRequestId, ownerClientId, streamVersion, threadId },
  ) {
    const stage = "Desktop IPC approval decision";
    const deadline = Date.now() + this.timeoutMs;

    for (;;) {
      const message = await transport.next(remainingMs(deadline, stage), stage);
      if (this.#handleDiscoveryRequest(transport, message)) continue;
      if (this.#handleFollowingStatusRequest(transport, message, { clientId, threadId })) {
        continue;
      }

      if (message.type === "broadcast" && message.method === STREAM_STATE_METHOD) {
        validateStreamUpdate(message, {
          clientId,
          hostId: this.hostId,
          ownerClientId,
          streamVersion,
          threadId,
        });
        continue;
      }

      if (message.type !== "response" || message.requestId !== decisionRequestId) continue;
      return message;
    }
  }

  #sendFollowing(transport, { clientId, threadId, targetClientIds } = {}) {
    transport.send({
      type: "broadcast",
      method: STREAM_FOLLOWING_METHOD,
      sourceClientId: clientId,
      ...(targetClientIds ? { targetClientIds } : {}),
      params: {
        conversationId: threadId,
        hostId: this.hostId,
        following: true,
      },
      version: STREAM_FOLLOWING_VERSION,
    });
  }

  #handleFollowingStatusRequest(transport, message, { clientId, threadId }) {
    if (message.type !== "broadcast" || message.method !== STREAM_FOLLOWING_STATUS_METHOD) {
      return false;
    }

    const params = message.params;
    if (!isRecord(params) || params.conversationId !== threadId || params.hostId !== this.hostId) {
      return true;
    }
    if (message.version !== STREAM_FOLLOWING_STATUS_VERSION) {
      throw new Error(
        `Desktop IPC ${STREAM_FOLLOWING_STATUS_METHOD} version mismatch: expected ${STREAM_FOLLOWING_STATUS_VERSION}`,
      );
    }
    if (!nonEmptyString(message.sourceClientId)) {
      throw new Error(`Desktop IPC ${STREAM_FOLLOWING_STATUS_METHOD} is missing sourceClientId`);
    }

    this.#sendFollowing(transport, {
      clientId,
      threadId,
      targetClientIds: [message.sourceClientId],
    });
    return true;
  }

  #handleDiscoveryRequest(transport, message) {
    if (message.type !== "client-discovery-request") return false;
    if (!nonEmptyString(message.requestId)) {
      throw new Error("Desktop IPC client discovery request is missing requestId");
    }
    transport.send({
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false },
    });
    return true;
  }
}

function parseInitializeResponse(message) {
  if (message.resultType === "error") {
    throw new Error(`Desktop IPC initialization failed: ${stringError(message.error)}`);
  }
  const clientId = message.result?.clientId;
  if (
    message.resultType !== "success"
    || message.method !== INITIALIZE_METHOD
    || !nonEmptyString(clientId)
    || message.handledByClientId !== clientId
  ) {
    throw new Error("Desktop IPC returned a malformed initialization response");
  }
  return clientId;
}

function parseApprovalSnapshot(message, { clientId, expectedApproval, hostId, threadId }) {
  if (!isSupportedDesktopStreamVersion(message.version)) {
    throw new Error(
      `Desktop IPC ${STREAM_STATE_METHOD} version mismatch: expected 11 or 13, received ${message.version}`,
    );
  }
  if (!nonEmptyString(message.sourceClientId) || message.sourceClientId === clientId) {
    throw new Error("Desktop IPC approval snapshot has an invalid owner client id");
  }
  if (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(clientId)) {
    throw new Error("Desktop IPC approval snapshot was not targeted to this client");
  }

  const params = message.params;
  if (!isRecord(params) || params.conversationId !== threadId || params.hostId !== hostId) {
    throw new Error("Desktop IPC approval snapshot conversation does not match the requested thread");
  }
  const change = params.change;
  if (!isRecord(change) || change.type !== "snapshot") {
    throw new Error("Desktop IPC expected a full conversation snapshot");
  }
  if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
    throw new Error("Desktop IPC approval snapshot has an invalid revision");
  }

  const conversationState = change.conversationState;
  if (!isRecord(conversationState) || conversationState.id !== threadId) {
    throw new Error("Desktop IPC snapshot state does not match the requested thread");
  }
  if (!Array.isArray(conversationState.requests)) {
    throw new Error("Desktop IPC approval snapshot is missing pending requests");
  }

  const commandApprovals = [];
  for (const request of conversationState.requests) {
    if (!isRecord(request) || !nonEmptyString(request.method)) {
      throw new Error("Desktop IPC approval snapshot contains a malformed pending request");
    }
    if (request.method === COMMAND_APPROVAL_METHOD) commandApprovals.push(request);
  }

  if (commandApprovals.length !== 1) {
    throw new Error(
      `Desktop IPC expected exactly one pending command approval; found ${commandApprovals.length}`,
    );
  }

  const approval = commandApprovals[0];
  if (!validRequestId(approval.id)) {
    throw new Error("Desktop IPC command approval has an invalid request id");
  }
  if (!isRecord(approval.params) || approval.params.threadId !== threadId) {
    throw new Error("Desktop IPC command approval belongs to a different thread");
  }
  validateApprovalCorrelation(approval.params, expectedApproval);

  return {
    ownerClientId: message.sourceClientId,
    approvalRequestId: approval.id,
    streamVersion: message.version,
  };
}

function validateApprovalCorrelation(params, expected) {
  if (expected.turnId && params.turnId !== expected.turnId) {
    throw new Error("Desktop IPC command approval belongs to a different turn");
  }
  if (expected.reason && params.reason !== expected.reason) {
    throw new Error("Desktop IPC command approval reason does not match the Xiaodex prompt");
  }
  if (expected.command) {
    const commandActions = Array.isArray(params.commandActions) ? params.commandActions : [];
    const matchesCommand = commandActions.some((action) =>
      isRecord(action) && action.command === expected.command);
    if (!matchesCommand) {
      throw new Error("Desktop IPC command approval command does not match the Xiaodex prompt");
    }
  }
}

function validateStreamUpdate(message, { clientId, hostId, ownerClientId, streamVersion, threadId }) {
  if (!isSupportedDesktopStreamVersion(message.version) || message.version !== streamVersion) {
    throw new Error(
      `Desktop IPC ${STREAM_STATE_METHOD} version mismatch: expected ${streamVersion}, received ${message.version}`,
    );
  }
  if (message.sourceClientId !== ownerClientId) {
    throw new Error("Desktop IPC stream update came from a different owner");
  }
  if (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(clientId)) {
    throw new Error("Desktop IPC stream update was not targeted to this client");
  }
  if (
    !isRecord(message.params)
    || message.params.conversationId !== threadId
    || message.params.hostId !== hostId
  ) {
    throw new Error("Desktop IPC stream update conversation does not match the requested thread");
  }

  const change = message.params.change;
  if (!isRecord(change) || (change.type !== "patches" && change.type !== "snapshot")) {
    throw new Error("Desktop IPC stream update has an invalid change payload");
  }
}

function parseDecisionResponse(message, { decisionRequestId, ownerClientId }) {
  if (message.requestId !== decisionRequestId) {
    throw new Error("Desktop IPC approval response id does not match the decision request");
  }
  if (message.resultType === "error") {
    throw new Error(`Desktop IPC approval decision failed: ${stringError(message.error)}`);
  }
  if (
    message.resultType !== "success"
    || message.method !== COMMAND_APPROVAL_DECISION_METHOD
    || message.handledByClientId !== ownerClientId
    || !isRecord(message.result)
    || message.result.ok !== true
  ) {
    throw new Error("Desktop IPC returned a malformed approval decision response");
  }
}

async function connectTransport({ socketPath, timeoutMs, maxFrameBytes }) {
  let socket;
  try {
    socket = net.createConnection({ path: socketPath });
  } catch (error) {
    throw new Error(`Unable to open Desktop IPC socket: ${stringError(error)}`, { cause: error });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(`Desktop IPC connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(new FramedJsonTransport(socket, { maxFrameBytes }));
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(`Unable to connect to Desktop IPC socket: ${stringError(error)}`, {
        cause: error,
      }));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Desktop IPC socket closed before connecting"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

class FramedJsonTransport {
  #buffer = Buffer.alloc(0);
  #closedIntentionally = false;
  #failure = null;
  #maxFrameBytes;
  #messages = [];
  #socket;
  #waiter = null;

  constructor(socket, { maxFrameBytes }) {
    this.#socket = socket;
    this.#maxFrameBytes = maxFrameBytes;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => {
      this.#fail(new Error(`Desktop IPC socket error: ${stringError(error)}`, { cause: error }));
    });
    socket.on("end", () => {
      if (!this.#closedIntentionally) this.#fail(new Error("Desktop IPC socket ended unexpectedly"));
    });
    socket.on("close", () => {
      if (!this.#closedIntentionally) this.#fail(new Error("Desktop IPC socket closed unexpectedly"));
    });
  }

  send(message) {
    if (this.#failure) throw this.#failure;
    if (this.#closedIntentionally || this.#socket.destroyed || !this.#socket.writable) {
      throw new Error("Desktop IPC socket is not writable");
    }

    let payload;
    try {
      payload = Buffer.from(JSON.stringify(message), "utf8");
    } catch (error) {
      throw new Error(`Unable to serialize Desktop IPC message: ${stringError(error)}`, {
        cause: error,
      });
    }
    if (payload.length === 0 || payload.length > this.#maxFrameBytes) {
      throw new Error(`Desktop IPC outgoing frame length ${payload.length} is invalid`);
    }

    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.#socket.write(frame);
  }

  next(timeoutMs, stage) {
    if (this.#messages.length > 0) return Promise.resolve(this.#messages.shift());
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#waiter) {
      return Promise.reject(new Error("Desktop IPC transport already has a pending reader"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.timer !== timer) return;
        this.#waiter = null;
        reject(new Error(`${stage} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#waiter = { resolve, reject, timer };
    });
  }

  close() {
    if (this.#closedIntentionally) return;
    this.#closedIntentionally = true;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Desktop IPC transport closed"));
    }
    this.#socket.destroy();
  }

  #onData(chunk) {
    if (this.#failure || this.#closedIntentionally || chunk.length === 0) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      if (this.#buffer.length < 4) return;
      const frameLength = this.#buffer.readUInt32LE(0);
      if (frameLength === 0 || frameLength > this.#maxFrameBytes) {
        this.#fail(new Error(`Desktop IPC incoming frame length ${frameLength} is invalid`));
        return;
      }
      if (this.#buffer.length < 4 + frameLength) return;

      const payload = this.#buffer.subarray(4, 4 + frameLength);
      this.#buffer = this.#buffer.subarray(4 + frameLength);

      let message;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        message = JSON.parse(text);
      } catch (error) {
        this.#fail(new Error(`Desktop IPC received a malformed JSON frame: ${stringError(error)}`, {
          cause: error,
        }));
        return;
      }
      if (!isRecord(message)) {
        this.#fail(new Error("Desktop IPC received a malformed message envelope"));
        return;
      }
      this.#emit(message);
    }
  }

  #emit(message) {
    if (!this.#waiter) {
      this.#messages.push(message);
      return;
    }
    const waiter = this.#waiter;
    this.#waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #fail(error) {
    if (this.#failure || this.#closedIntentionally) return;
    this.#failure = error;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#socket.destroy();
  }
}

function validateApprovalContext(context) {
  const threadId = context?.threadId;
  if (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)) {
    throw new TypeError("Desktop IPC approval requires a canonical UUID threadId");
  }
  const expected = {
    threadId: threadId.toLowerCase(),
    callId: optionalString(context.callId, "callId"),
    turnId: optionalString(context.turnId, "turnId"),
    command: optionalString(context.command, "command"),
    reason: optionalString(context.reason, "reason"),
  };
  if (!expected.turnId && !(expected.command && expected.reason)) {
    throw new TypeError(
      "Desktop IPC approval requires a turnId or both command and reason correlation",
    );
  }
  return expected;
}

function optionalString(value, name) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function validateDecision(value) {
  if (value !== "accept" && value !== "decline") {
    throw new TypeError('Desktop IPC approval decision must be "accept" or "decline"');
  }
  return value;
}

function positiveInteger(value, fallback, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
}

function remainingMs(deadline, stage) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${stage} timed out`);
  return remaining;
}

function validRequestId(value) {
  return nonEmptyString(value) || (Number.isSafeInteger(value) && value >= 0);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringError(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string" && value.length > 0) return value;
  return "unknown error";
}
