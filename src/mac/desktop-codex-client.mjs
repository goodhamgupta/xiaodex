import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { defaultDesktopIpcSocketPath, isSupportedDesktopStreamVersion } from "./desktop-ipc-approval.mjs";

const INITIALIZING_CLIENT_ID = "initializing-client";
const INITIALIZE_METHOD = "initialize";
const INITIALIZE_VERSION = 0;
const FOLLOW_METHOD = "thread-stream-following-changed";
const FOLLOW_VERSION = 1;
const FOLLOW_STATUS_METHOD = "thread-stream-following-status-requested";
const FOLLOW_STATUS_VERSION = 1;
const STREAM_METHOD = "thread-stream-state-changed";
const START_TURN_METHOD = "thread-follower-start-turn";
const START_TURN_VERSION = 2;
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";
const COMMAND_DECISION_METHOD = "thread-follower-command-approval-decision";
const FILE_DECISION_METHOD = "thread-follower-file-approval-decision";
const PERMISSIONS_DECISION_METHOD = "thread-follower-permissions-request-approval-response";
const DECISION_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const PATCH_OPERATIONS = new Set(["add", "replace", "remove"]);
const RESERVED_PATCH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_METHODS = new Set([
  COMMAND_APPROVAL_METHOD,
  FILE_APPROVAL_METHOD,
  PERMISSIONS_APPROVAL_METHOD,
]);
const TERMINAL_TURN_STATES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "canceled",
]);

// Codex Desktop owns its app-server over stdio. This adapter uses Desktop's
// owner/follower coordination bus so Xiaodex submits into that same live
// process instead of starting a second app-server with a divergent event
// stream. The protocol is deliberately fail-closed because it is internal and
// versioned by Desktop.
export class DesktopCodexClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.socketPath = options.socketPath || defaultDesktopIpcSocketPath();
    this.clientType = options.clientType || "xiaodex-bridge";
    this.hostId = options.hostId || "local";
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connectPromise = null;
    this.initializePromise = null;
    this.clientId = "";
    this.pending = new Map();
    this.followWaiter = null;
    this.threadId = "";
    this.ownerClientId = "";
    this.revision = null;
    this.streamVersion = null;
    this.state = null;
    this.activeTurn = null;
    this.pendingApprovals = new Map();
    this.retiredThreadIds = new Set();
    this.stopped = false;
    this.failed = null;
    this.exitEmitted = false;
  }

  start() {
    if (this.socket || this.connectPromise) return;
    if (this.stopped) throw new Error("Codex Desktop client is stopped");

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ path: this.socketPath });
      this.socket = socket;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        const error = new Error(
          `Codex Desktop IPC connection timed out after ${this.requestTimeoutMs}ms`,
        );
        reject(error);
        this.#fail(error);
      }, this.requestTimeoutMs);

      const settle = (callback) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        callback();
        return true;
      };

      socket.once("connect", () => settle(resolve));
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("error", (error) => {
        const wrapped = new Error(
          `Unable to connect to Codex Desktop IPC socket ${this.socketPath}: ${stringError(error)}`,
          { cause: error },
        );
        if (!settle(() => reject(wrapped))) this.#fail(wrapped);
      });
      socket.on("end", () => {
        if (!this.stopped) this.#fail(new Error("Codex Desktop IPC socket ended unexpectedly"));
      });
      socket.on("close", () => {
        if (!this.stopped && !this.failed) {
          this.#fail(new Error("Codex Desktop IPC socket closed unexpectedly"));
        }
      });
    });
    this.connectPromise.catch(() => {});
  }

  async initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.start();
    this.initializePromise = this.#initialize();
    return this.initializePromise;
  }

  async #initialize() {
    try {
      await this.connectPromise;
      const response = await this.#requestEnvelope({
        method: INITIALIZE_METHOD,
        params: { clientType: this.clientType },
        sourceClientId: INITIALIZING_CLIENT_ID,
        version: INITIALIZE_VERSION,
      });
      if (response.resultType === "error") {
        throw new Error(`Codex Desktop IPC initialization failed: ${stringError(response.error)}`);
      }
      const clientId = response.result?.clientId;
      if (
        response.resultType !== "success" ||
        response.method !== INITIALIZE_METHOD ||
        !nonEmptyString(clientId) ||
        response.handledByClientId !== clientId
      ) {
        throw new Error("Codex Desktop IPC returned a malformed initialization response");
      }
      this.clientId = clientId;
      return { userAgent: "Codex Desktop (shared app-server)" };
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.initialize();
    if (method === "thread/list") {
      return { data: this.state ? [threadSummary(this.state)] : [] };
    }
    if (method === "thread/resume") {
      const threadId = canonicalThreadId(params.threadId);
      await this.#follow(threadId);
      return { thread: threadSummary(this.state) };
    }
    if (method === "turn/start") return this.#startTurn(params);
    throw new Error(`Codex Desktop shared client does not support ${method}`);
  }

  notify() {
    // Desktop IPC performs its own initialization handshake; there is no
    // separate app-server `initialized` notification on this transport.
  }

  async respond(requestId, result = {}) {
    await this.initialize();
    const key = requestKey(requestId);
    const request = this.pendingApprovals.get(key);
    if (!request) throw new Error("Codex Desktop approval is no longer pending");
    if (!this.threadId || !this.ownerClientId) {
      throw new Error("Codex Desktop task owner is unavailable");
    }

    let method;
    let params;
    if (request.method === COMMAND_APPROVAL_METHOD) {
      method = COMMAND_DECISION_METHOD;
      params = approvalDecisionParams(this.threadId, request.id, result.decision);
    } else if (request.method === FILE_APPROVAL_METHOD) {
      method = FILE_DECISION_METHOD;
      params = approvalDecisionParams(this.threadId, request.id, result.decision);
    } else if (request.method === PERMISSIONS_APPROVAL_METHOD) {
      method = PERMISSIONS_DECISION_METHOD;
      params = {
        conversationId: this.threadId,
        requestId: request.id,
        response: permissionsDecision(request.params, result.decision),
      };
    } else {
      throw new Error(`Unsupported Codex Desktop approval method ${request.method}`);
    }

    const response = await this.#requestEnvelope({
      method,
      params,
      sourceClientId: this.clientId,
      targetClientId: this.ownerClientId,
      timeoutMs: this.requestTimeoutMs,
      version: DECISION_VERSION,
      fatalOnTimeout: true,
    });
    validateOwnerResponse(response, {
      method,
      ownerClientId: this.ownerClientId,
      requireOk: true,
    });
    this.pendingApprovals.delete(key);
    return response.result;
  }

  rejectRequest(requestId, _code, message) {
    this.respond(requestId, { decision: "decline" }).catch((error) => {
      this.emit("protocolError", new Error(`${message}: ${error.message}`));
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.socket?.writable && this.clientId && this.threadId) {
      try {
        this.#sendFollow(this.threadId, false);
      } catch {
        // Shutdown is best effort; never keep the bridge alive for an unfollow.
      }
    }
    const error = new Error("Codex Desktop client stopped");
    this.#rejectWaiters(error);
    this.socket?.destroy();
    this.socket = null;
  }

  async #follow(threadId) {
    if (this.failed) throw this.failed;
    if (this.threadId === threadId && this.state && this.ownerClientId) return;
    if (this.followWaiter) throw new Error("Codex Desktop task follow is already in progress");

    if (this.threadId) {
      this.#retireThread(this.threadId);
      this.#resolvePendingApprovals();
      this.emit("notification", {
        method: "thread/closed",
        params: { threadId: this.threadId },
      });
      this.#sendFollow(this.threadId, false);
    }
    this.threadId = threadId;
    this.retiredThreadIds.delete(threadId);
    this.ownerClientId = "";
    this.revision = null;
    this.streamVersion = null;
    this.state = null;
    this.activeTurn = null;
    this.pendingApprovals.clear();

    const waiter = { promise: null, resolve: null, reject: null, timer: null, threadId };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        if (this.followWaiter !== waiter) return;
        this.followWaiter = null;
        reject(new Error(`Codex Desktop task owner timed out for ${threadId}`));
      }, this.requestTimeoutMs);
    });
    waiter.promise = promise;
    this.followWaiter = waiter;
    this.#sendFollow(threadId, true);
    return promise;
  }

  async #startTurn(params) {
    const threadId = canonicalThreadId(params.threadId);
    if (threadId !== this.threadId || !this.state || !this.ownerClientId) {
      throw new Error("Codex Desktop task must be resumed before turn/start");
    }
    if (this.activeTurn && !this.activeTurn.completed) {
      throw new Error("Codex Desktop task already has an active Xiaodex turn");
    }
    if (!Array.isArray(params.input) || params.input.length === 0) {
      throw new Error("Codex Desktop turn/start requires input");
    }

    const clientUserMessageId = randomUUID();
    const { threadId: _threadId, ...turnStartParams } = params;
    this.activeTurn = {
      clientUserMessageId,
      turnId: "",
      entityKey: "",
      itemText: new Map(),
      completedItems: new Set(),
      emittedRequests: new Set(),
      completed: false,
    };

    let response;
    try {
      response = await this.#requestEnvelope({
        method: START_TURN_METHOD,
        params: {
          conversationId: threadId,
          turnStart: {
            request: { ...turnStartParams, threadId, clientUserMessageId },
          },
        },
        sourceClientId: this.clientId,
        targetClientId: this.ownerClientId,
        timeoutMs: this.requestTimeoutMs,
        version: START_TURN_VERSION,
        fatalOnTimeout: true,
      });
      validateOwnerResponse(response, {
        method: START_TURN_METHOD,
        ownerClientId: this.ownerClientId,
      });
      const accepted = response.result?.result;
      const turn = accepted?.turn || accepted;
      if (!nonEmptyString(turn?.id)) {
        throw new Error("Codex Desktop returned a malformed turn/start result");
      }
      this.activeTurn.turnId = turn.id;
      this.#translateState(this.state, this.state);
      this.emit("notification", {
        method: "turn/started",
        params: { threadId, turn },
      });
      return accepted;
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }
  }

  #sendFollow(threadId, following, targetClientIds) {
    this.#send({
      type: "broadcast",
      method: FOLLOW_METHOD,
      sourceClientId: this.clientId,
      ...(targetClientIds ? { targetClientIds } : {}),
      params: { conversationId: threadId, hostId: this.hostId, following },
      version: FOLLOW_VERSION,
    });
  }

  #handleMessage(message) {
    if (!isRecord(message)) {
      this.#fail(new Error("Codex Desktop IPC received a malformed message envelope"));
      return;
    }

    if (message.type === "response" && nonEmptyString(message.requestId)) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    if (message.type === "client-discovery-request") {
      if (!nonEmptyString(message.requestId)) {
        this.#fail(new Error("Codex Desktop client discovery request is missing requestId"));
        return;
      }
      this.#send({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }

    if (message.type === "broadcast" && message.method === FOLLOW_STATUS_METHOD) {
      if (message.version !== FOLLOW_STATUS_VERSION) {
        this.#fail(new Error(`Codex Desktop ${FOLLOW_STATUS_METHOD} version mismatch`));
        return;
      }
      if (
        message.params?.conversationId === this.threadId &&
        message.params?.hostId === this.hostId &&
        nonEmptyString(message.sourceClientId)
      ) {
        this.#sendFollow(this.threadId, true, [message.sourceClientId]);
      }
      return;
    }

    if (message.type === "broadcast" && message.method === STREAM_METHOD) {
      this.#handleStream(message);
      return;
    }

    if (
      message.type === "broadcast" &&
      message.method === "client-status-changed" &&
      message.params?.status === "disconnected" &&
      message.params?.clientId === this.ownerClientId
    ) {
      this.#fail(new Error("Codex Desktop task owner disconnected"));
    }
  }

  #handleStream(message) {
    try {
      if (!isSupportedDesktopStreamVersion(message.version)) {
        throw new Error(
          `Codex Desktop ${STREAM_METHOD} version mismatch: expected 11 or 13, received ${message.version}`,
        );
      }
      if (!Array.isArray(message.targetClientIds) || !message.targetClientIds.includes(this.clientId)) {
        throw new Error("Codex Desktop stream update was not targeted to Xiaodex");
      }
      const conversationId = message.params?.conversationId;
      if (conversationId !== this.threadId) {
        if (this.retiredThreadIds.has(conversationId)) return;
        throw new Error("Codex Desktop stream update belongs to another task");
      }
      if (message.params?.hostId !== this.hostId) {
        throw new Error("Codex Desktop stream update belongs to another host");
      }
      if (!nonEmptyString(message.sourceClientId) || message.sourceClientId === this.clientId) {
        throw new Error("Codex Desktop stream update has an invalid owner");
      }
      if (this.ownerClientId && message.sourceClientId !== this.ownerClientId) {
        throw new Error("Codex Desktop task owner changed during a followed turn");
      }
      if (this.streamVersion !== null && this.streamVersion !== message.version) {
        throw new Error("Codex Desktop stream version changed during a followed task");
      }

      const change = message.params.change;
      if (!isRecord(change)) throw new Error("Codex Desktop stream update has no change payload");
      if (change.type === "snapshot") {
        const state = cloneRecord(change.conversationState, "Desktop conversation snapshot");
        if (state.id !== this.threadId) {
          throw new Error("Codex Desktop snapshot task id does not match");
        }
        if (!validRevision(change.revision)) {
          throw new Error("Codex Desktop snapshot revision is invalid");
        }
        const previous = this.state;
        this.ownerClientId = message.sourceClientId;
        this.streamVersion = message.version;
        this.revision = change.revision;
        this.state = state;
        if (previous && this.activeTurn) this.#translateState(previous, state);
        this.#resolveFollow();
        return;
      }
      if (change.type !== "patches") {
        throw new Error("Codex Desktop stream change type is unsupported");
      }
      if (!this.state || !this.ownerClientId || this.revision === null) {
        if (this.followWaiter) return;
        throw new Error("Codex Desktop sent patches before the baseline snapshot");
      }
      if (!validRevision(change.baseRevision) || !validRevision(change.revision)) {
        throw new Error("Codex Desktop stream patch revision is invalid");
      }
      if (change.revision <= this.revision) return;
      if (change.baseRevision !== this.revision || change.revision !== change.baseRevision + 1) {
        throw new Error(
          `Codex Desktop stream revision gap: have ${this.revision}, ` +
          `received ${change.baseRevision}->${change.revision}`,
        );
      }
      if (!Array.isArray(change.patches)) {
        throw new Error("Codex Desktop patch list is invalid");
      }
      const previous = this.state;
      const next = applyStrictPatches(previous, change.patches);
      if (!isRecord(next) || next.id !== this.threadId) {
        throw new Error("Codex Desktop patches produced a mismatched task state");
      }
      this.state = next;
      this.revision = change.revision;
      this.#translateState(previous, next);
    } catch (error) {
      this.#fail(error);
    }
  }

  #translateState(_previous, next) {
    const active = this.activeTurn;
    if (!active || active.completed) return;
    const turn = findActiveTurn(next, active);
    if (!turn) return;
    if (nonEmptyString(turn.turnId)) {
      if (active.turnId && active.turnId !== turn.turnId) {
        this.#fail(new Error("Codex Desktop active turn id changed unexpectedly"));
        return;
      }
      active.turnId = turn.turnId;
    }
    if (!active.turnId) return;

    const currentItemIds = new Set();
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item?.type !== "agentMessage" || !nonEmptyString(item.id)) continue;
      currentItemIds.add(item.id);
      const text = typeof item.text === "string" ? item.text : "";
      const previousText = active.itemText.get(item.id) || "";
      if (text !== previousText) {
        const isPrefix = text.startsWith(previousText);
        const delta = isPrefix ? text.slice(previousText.length) : text;
        active.itemText.set(item.id, text);
        if (delta || !isPrefix) {
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: {
              threadId: this.threadId,
              turnId: active.turnId,
              itemId: item.id,
              delta,
              ...(!isPrefix ? { reset: true } : {}),
            },
          });
        }
      }
    }
    for (const itemId of [...active.itemText.keys()]) {
      if (currentItemIds.has(itemId)) continue;
      active.itemText.delete(itemId);
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: {
          threadId: this.threadId,
          turnId: active.turnId,
          itemId,
          delta: "",
          reset: true,
        },
      });
    }

    this.#translateRequests(next, active);

    const status = turnStatus(turn);
    if (!TERMINAL_TURN_STATES.has(status)) return;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (item?.type !== "agentMessage" || !nonEmptyString(item.id)) continue;
      if (active.completedItems.has(item.id)) continue;
      active.completedItems.add(item.id);
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId: active.turnId,
          item: structuredClone(item),
        },
      });
    }
    active.completed = true;
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turnId: active.turnId,
        turn: { id: active.turnId, status },
      },
    });
    this.#resolvePendingApprovals((request) => request.params?.turnId === active.turnId);
  }

  #translateRequests(state, active) {
    const present = new Set();
    for (const request of Array.isArray(state.requests) ? state.requests : []) {
      if (!isRecord(request) || !APPROVAL_METHODS.has(request.method)) continue;
      if (!validRequestId(request.id) || !isRecord(request.params)) {
        this.#fail(new Error("Codex Desktop approval request is malformed"));
        return;
      }
      if (
        request.params.threadId !== this.threadId ||
        request.params.turnId !== active.turnId
      ) {
        continue;
      }
      const key = requestKey(request.id);
      present.add(key);
      if (active.emittedRequests.has(key)) continue;
      active.emittedRequests.add(key);
      this.pendingApprovals.set(key, structuredClone(request));
      this.emit("serverRequest", structuredClone(request));
    }

    for (const [key, request] of this.pendingApprovals) {
      if (request.params?.turnId !== active.turnId || present.has(key)) continue;
      this.pendingApprovals.delete(key);
      this.emit("notification", {
        method: "serverRequest/resolved",
        params: { threadId: this.threadId, requestId: request.id },
      });
    }
  }

  #resolveFollow() {
    const waiter = this.followWaiter;
    if (!waiter || waiter.threadId !== this.threadId) return;
    this.followWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  #resolvePendingApprovals(predicate = () => true) {
    for (const [key, request] of this.pendingApprovals) {
      if (!predicate(request)) continue;
      this.pendingApprovals.delete(key);
      this.emit("notification", {
        method: "serverRequest/resolved",
        params: { threadId: this.threadId, requestId: request.id },
      });
    }
  }

  #retireThread(threadId) {
    this.retiredThreadIds.delete(threadId);
    this.retiredThreadIds.add(threadId);
    while (this.retiredThreadIds.size > 8) {
      this.retiredThreadIds.delete(this.retiredThreadIds.values().next().value);
    }
  }

  #requestEnvelope({
    method,
    params,
    sourceClientId,
    targetClientId,
    timeoutMs,
    version,
    fatalOnTimeout = false,
  }) {
    if (this.failed) return Promise.reject(this.failed);
    const requestId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        const error = new Error(
          `Codex Desktop ${method} timed out after dispatch; ownership is indeterminate`,
        );
        if (fatalOnTimeout) {
          this.#fail(error);
          return;
        }
        this.pending.delete(requestId);
        reject(error);
      }, timeoutMs || this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
    });
    this.#send({
      type: "request",
      requestId,
      sourceClientId,
      version,
      method,
      params,
      ...(targetClientId ? { targetClientId } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return promise;
  }

  #send(message) {
    if (this.failed) throw this.failed;
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new Error("Codex Desktop IPC socket is not writable");
    }
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (payload.length === 0 || payload.length > this.maxFrameBytes) {
      throw new Error(`Codex Desktop IPC outgoing frame length ${payload.length} is invalid`);
    }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    socket.write(frame);
  }

  #onData(chunk) {
    if (this.failed || this.stopped || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > this.maxFrameBytes) {
        this.#fail(new Error(`Codex Desktop IPC incoming frame length ${length} is invalid`));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
      } catch (error) {
        this.#fail(new Error(`Codex Desktop IPC received malformed JSON: ${stringError(error)}`));
        return;
      }
      this.#handleMessage(message);
      if (this.failed) return;
    }
  }

  #fail(value) {
    if (this.failed || this.stopped) return;
    const error = value instanceof Error ? value : new Error(stringError(value));
    this.failed = error;
    this.#resolvePendingApprovals();
    if (this.threadId) {
      this.emit("notification", {
        method: "thread/closed",
        params: { threadId: this.threadId },
      });
    }
    this.#rejectWaiters(error);
    this.socket?.destroy();
    this.emit("protocolError", error);
    if (!this.exitEmitted) {
      this.exitEmitted = true;
      this.emit("exit", { code: null, signal: "DESKTOP_IPC", error });
    }
  }

  #rejectWaiters(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.followWaiter) {
      const waiter = this.followWaiter;
      this.followWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

export function applyStrictPatches(value, patches) {
  let root = value;
  for (const patch of patches) {
    if (!isRecord(patch) || !Array.isArray(patch.path)) {
      throw new Error("Codex Desktop patch is malformed");
    }
    if (!PATCH_OPERATIONS.has(patch.op)) {
      throw new Error(`Codex Desktop patch operation ${String(patch.op)} is unsupported`);
    }
    if (patch.path.some((segment) => RESERVED_PATCH_KEYS.has(String(segment)))) {
      throw new Error("Codex Desktop patch contains a reserved property name");
    }
    if (patch.path.length === 0) {
      if (patch.op === "remove") throw new Error("Codex Desktop cannot remove the root state");
      if (!("value" in patch)) throw new Error("Codex Desktop root patch has no value");
      root = structuredClone(patch.value);
      continue;
    }
    root = applyPatchAt(root, patch, 0);
  }
  return root;
}

function applyPatchAt(node, patch, depth) {
  const key = patch.path[depth];
  const leaf = depth === patch.path.length - 1;
  if (Array.isArray(node)) {
    const index = arrayIndex(key, leaf && patch.op === "add" ? node.length : node.length - 1);
    const clone = node.slice();
    if (!leaf) {
      clone[index] = applyPatchAt(node[index], patch, depth + 1);
      return clone;
    }
    if (patch.op === "add") {
      if (!("value" in patch)) throw new Error("Codex Desktop add patch has no value");
      clone.splice(index, 0, structuredClone(patch.value));
    } else if (patch.op === "replace") {
      if (!("value" in patch)) throw new Error("Codex Desktop replace patch has no value");
      clone[index] = structuredClone(patch.value);
    } else {
      clone.splice(index, 1);
    }
    return clone;
  }

  if (!isRecord(node) || (typeof key !== "string" && typeof key !== "number")) {
    throw new Error("Codex Desktop patch parent is invalid");
  }
  const property = String(key);
  if (!leaf) {
    const child = childAt(node, property, "patch path");
    return { ...node, [property]: applyPatchAt(child, patch, depth + 1) };
  }
  // Immer can replace/remove an object property whose previous undefined value
  // was omitted from the JSON snapshot. Ancestors and array bounds still need
  // to exist, and applyStrictPatches rejects prototype-related keys above.
  const clone = { ...node };
  if (patch.op === "remove") delete clone[property];
  else {
    if (!("value" in patch)) throw new Error(`Codex Desktop ${patch.op} patch has no value`);
    clone[property] = structuredClone(patch.value);
  }
  return clone;
}

function childAt(parent, key, stage) {
  if (Array.isArray(parent)) return parent[arrayIndex(key, parent.length - 1)];
  if (!isRecord(parent) || (typeof key !== "string" && typeof key !== "number")) {
    throw new Error(`Codex Desktop ${stage} is invalid`);
  }
  const property = String(key);
  if (!Object.hasOwn(parent, property)) {
    throw new Error(`Codex Desktop ${stage} does not exist: ${property}`);
  }
  return parent[property];
}

function arrayIndex(value, maximum) {
  const index = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new Error(`Codex Desktop patch array index ${String(value)} is invalid`);
  }
  return index;
}

function findActiveTurn(state, active) {
  const entities = state?.turnHistory?.history?.entitiesByKey;
  if (active.entityKey && isRecord(entities?.[active.entityKey])) {
    const cached = entities[active.entityKey];
    const matchesId = active.turnId &&
      (cached.turnId === active.turnId || cached.id === active.turnId);
    const matchesClient =
      cached.params?.clientUserMessageId === active.clientUserMessageId ||
      cached.clientUserMessageId === active.clientUserMessageId;
    if (matchesId || matchesClient) return normalizeTurn(cached);
    active.entityKey = "";
  }
  if (isRecord(entities)) {
    for (const [key, turn] of Object.entries(entities)) {
      if (!isRecord(turn)) continue;
      const matchesId = active.turnId && (turn.turnId === active.turnId || turn.id === active.turnId);
      const matchesClient =
        turn.params?.clientUserMessageId === active.clientUserMessageId ||
        turn.clientUserMessageId === active.clientUserMessageId;
      if (!matchesId && !matchesClient) continue;
      active.entityKey = key;
      return normalizeTurn(turn);
    }
  }

  const turns = Array.isArray(state?.turns) ? state.turns.filter(isRecord) : [];
  if (active.turnId) {
    const exact = turns.find((turn) => turn?.turnId === active.turnId || turn?.id === active.turnId);
    if (exact) return normalizeTurn(exact);
  }
  const provisional = turns.find((turn) =>
    turn?.params?.clientUserMessageId === active.clientUserMessageId ||
    turn?.clientUserMessageId === active.clientUserMessageId);
  return provisional ? normalizeTurn(provisional) : null;
}

function normalizeTurn(turn) {
  return {
    ...turn,
    turnId: turn.turnId || turn.id || "",
    items: Array.isArray(turn.items) ? turn.items : [],
  };
}

function turnStatus(turn) {
  const status = typeof turn?.status === "string" ? turn.status : turn?.status?.type;
  return typeof status === "string" ? status.toLowerCase() : "";
}

function threadSummary(state) {
  const status = state.threadRuntimeStatus || state.status || { type: "idle" };
  return {
    id: state.id,
    title: state.title || null,
    preview: state.preview || state.title || "Codex Desktop task",
    cwd: state.cwd,
    updatedAt: state.updatedAt,
    status,
  };
}

function canonicalThreadId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Codex Desktop requires a canonical UUID task id");
  }
  return value.toLowerCase();
}

function approvalDecisionParams(conversationId, requestId, decision) {
  if (decision !== "accept" && decision !== "decline") {
    throw new Error("Codex Desktop approval decision must be accept or decline");
  }
  return { conversationId, requestId, decision };
}

function permissionsDecision(params, decision) {
  if (decision === "decline") return { permissions: {}, scope: "turn" };
  if (decision !== "accept") {
    throw new Error("Codex Desktop approval decision must be accept or decline");
  }
  const requested = params?.permissions ?? params?.requestedPermissions;
  if (!isRecord(requested)) {
    throw new Error("Codex Desktop permission request does not expose a safe grant subset");
  }
  const permissions = {};
  if (Object.hasOwn(requested, "network")) {
    permissions.network = structuredClone(requested.network);
  }
  if (Object.hasOwn(requested, "fileSystem")) {
    permissions.fileSystem = structuredClone(requested.fileSystem);
  }
  if (Object.keys(permissions).length === 0) {
    throw new Error("Codex Desktop permission request has no supported one-turn grants");
  }
  return { permissions, scope: "turn" };
}

function validateOwnerResponse(response, { method, ownerClientId, requireOk = false }) {
  if (response.resultType === "error") {
    throw new Error(`Codex Desktop ${method} failed: ${stringError(response.error)}`);
  }
  if (
    response.resultType !== "success" ||
    response.method !== method ||
    response.handledByClientId !== ownerClientId ||
    !isRecord(response.result)
  ) {
    throw new Error(`Codex Desktop returned a malformed ${method} response`);
  }
  if (requireOk && response.result.ok !== true) {
    throw new Error(`Codex Desktop did not acknowledge ${method}`);
  }
}

function cloneRecord(value, stage) {
  if (!isRecord(value)) throw new Error(`${stage} is malformed`);
  return structuredClone(value);
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRequestId(value) {
  return nonEmptyString(value) || (Number.isSafeInteger(value) && value >= 0);
}

function requestKey(value) {
  return `${typeof value}:${String(value)}`;
}

function positiveInteger(value, fallback, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
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
