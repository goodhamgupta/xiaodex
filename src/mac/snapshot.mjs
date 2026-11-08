import crypto from "node:crypto";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

export const PET_ID = "codex-spark";

export function isApprovalMethod(method) {
  return APPROVAL_METHODS.has(method);
}

export class SnapshotState {
  constructor(options = {}) {
    this.now = options.now || (() => new Date());
    this.threads = new Map();
    this.pendingApprovals = new Map();
    this.entries = [];
    this.entryKeys = [];
    this.threadOutputTokens = new Map();
    this.turnOutputTokens = new Map();
    this.todayOutputTotals = new Map();
    this.desktopCalls = new Map();
    this.tokensToday = 0;
    this.dayKey = this.#dayKey();
    this.lastCompletedAt = 0;
  }

  applyThreadList(threads) {
    for (const thread of threads || []) this.applyThread(thread);
  }

  applyThread(thread) {
    if (!thread?.id) return;
    const existing = this.threads.get(thread.id) || {};
    this.threads.set(thread.id, { ...existing, ...thread });
  }

  applyNotification(message) {
    const { method, params = {} } = message;
    if (method === "thread/started") {
      this.applyThread(params.thread);
      this.#entry(`started ${shortThread(params.thread?.id)}`);
      return;
    }
    if (method === "thread/status/changed") {
      const current = this.threads.get(params.threadId) || { id: params.threadId, preview: "" };
      this.threads.set(params.threadId, { ...current, status: params.status });
      this.#entry(`${shortThread(params.threadId)} ${statusLabel(params.status)}`);
      return;
    }
    if (method === "thread/closed") {
      const current = this.threads.get(params.threadId);
      if (current) this.threads.set(params.threadId, { ...current, status: { type: "notLoaded" } });
      return;
    }
    if (method === "turn/started") {
      this.#entry(`turn started ${shortThread(params.threadId)}`);
      return;
    }
    if (method === "turn/completed") {
      this.#entry(`turn completed ${shortThread(params.threadId)}`);
      this.lastCompletedAt = this.now().getTime();
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.#applyTokenUsage(params);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const line = itemLine(params.item, method.endsWith("completed"));
      if (line) this.#entry(line);
    }
  }

  addApproval(request) {
    const prompt = promptFromApproval(request);
    const approval = { ...prompt, request, source: "app-server" };
    for (const [existingId, existing] of this.pendingApprovals) {
      if (existing.source !== "desktop-session-log" || !sameApprovalContext(existing, approval)) {
        continue;
      }
      const upgraded = {
        ...existing,
        ...prompt,
        id: existing.id,
        threadId: existing.threadId,
        request,
        source: "app-server",
      };
      this.pendingApprovals.set(existingId, upgraded);
      return upgraded;
    }
    this.pendingApprovals.set(prompt.id, approval);
    this.#entry(`approval ${prompt.tool}`);
    return prompt;
  }

  addEntry(text) {
    this.#entry(text);
  }

  resolveApproval(promptId) {
    const approval = this.pendingApprovals.get(promptId);
    if (approval) {
      this.pendingApprovals.delete(promptId);
      if (approval.threadId) this.#setSessionApprovalFlag(approval.threadId);
    }
    return approval;
  }

  resolveApprovalForRequestId(requestId) {
    if (requestId === undefined || requestId === null) return false;
    for (const [promptId, approval] of this.pendingApprovals) {
      if (approval.source !== "app-server" || !approval.request) continue;
      if (String(approval.request?.id) !== String(requestId)) continue;
      this.resolveApproval(promptId);
      return true;
    }
    return false;
  }

  approvalFor(promptId) {
    return this.pendingApprovals.get(promptId) || null;
  }

  desktopApprovalCount() {
    return [...this.pendingApprovals.values()]
      .filter((approval) => approval.source === "desktop-session-log")
      .length;
  }

  applySessionLogEvent(event) {
    const payload = event?.payload || {};
    const threadId = `desktop:${event?.__sessionId || "desktop-session"}`;
    const markActive = (activeFlags = []) => this.applyThread({ id: threadId, status: { type: "active", activeFlags } });
    const markIdle = () => {
      this.#clearSessionApprovals(threadId);
      this.applyThread({ id: threadId, status: { type: "idle" } });
    };
    const addMessage = (role, text) => {
      const value = squash(text);
      if (!value || shouldIgnoreSessionMessage(role, value)) return;
      this.#entry(`${role === "assistant" ? "msg" : "user"} ${value}`);
    };

    if (event?.type === "event_msg") {
      if (payload.type === "task_started") {
        markActive();
        this.#entry("turn started desktop");
        return true;
      }
      if (payload.type === "user_message") {
        markActive();
        addMessage("user", payload.message);
        return true;
      }
      if (payload.type === "agent_message") {
        markActive();
        addMessage("assistant", payload.message);
        return true;
      }
      if (payload.type === "task_complete") {
        markIdle();
        this.#entry("turn completed desktop");
        this.lastCompletedAt = this.now().getTime();
        return true;
      }
      if (payload.type === "patch_apply_end") {
        markActive();
        return true;
      }
      if (payload.type === "token_count") {
        this.#applySessionTokenCount(payload.info, {
          sourceId: threadId,
          sessionDay: event.__sessionDay,
          timestamp: event.timestamp,
        });
        return true;
      }
    }

    if (event?.type === "response_item") {
      if (payload.type === "message") {
        if (payload.role !== "assistant" && payload.role !== "user") return false;
        markActive();
        addMessage(payload.role, contentText(payload.content));
        return true;
      }
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        markActive();
        const call = desktopCallFromPayload(payload);
        if (payload.call_id) this.desktopCalls.set(payload.call_id, call);
        if (call.prompt) {
          this.#addSessionApproval(threadId, call.prompt);
          markActive(["waitingOnApproval"]);
        }
        return true;
      }
      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        markActive();
        const call = this.desktopCalls.get(payload.call_id);
        if (payload.call_id) this.desktopCalls.delete(payload.call_id);
        const promptId = call?.prompt?.id || (payload.call_id ? promptIdFor({ id: payload.call_id }) : "");
        if (promptId) this.resolveApproval(promptId);
        return true;
      }
    }

    return false;
  }

  toSnapshot() {
    this.#rollDayIfNeeded();
    const threads = [...this.threads.values()];
    const waitingByStatus = threads.filter((thread) => hasActiveFlag(thread, "waitingOnApproval")).length;
    const running = threads.filter((thread) => {
      if (thread?.status?.type !== "active") return false;
      return !hasActiveFlag(thread, "waitingOnApproval") && !hasActiveFlag(thread, "waitingOnUserInput");
    }).length;
    const waiting = Math.max(this.pendingApprovals.size, waitingByStatus);
    const prompt = this.#currentPrompt();
    const total = threads.filter((thread) => thread?.status?.type !== "notLoaded").length;
    const completed = this.#recentlyCompleted();
    const petState = petStateFor({ total, running, waiting, completed });

    return {
      total,
      running,
      waiting,
      completed,
      pet_state: petState,
      pet: {
        id: PET_ID,
        state: petState,
        source: "codex-state",
        sprite_pack: PET_ID,
        sprite_provider: "imagen",
      },
      msg: prompt ? `approve: ${prompt.tool}` : messageFor({ total, running, waiting }),
      entries: this.entries.slice(0, 8),
      tokens: this.#totalOutputTokens(),
      tokens_today: this.tokensToday,
      ...(prompt ? { prompt: { id: prompt.id, tool: prompt.tool, hint: prompt.hint } } : {}),
    };
  }

  #currentPrompt() {
    return this.pendingApprovals.values().next().value || null;
  }

  #addSessionApproval(threadId, prompt) {
    const approval = {
      ...prompt,
      request: null,
      source: "desktop-session-log",
      threadId,
    };
    for (const existing of this.pendingApprovals.values()) {
      if (existing.source === "app-server" && sameApprovalContext(existing, approval)) return;
    }
    if (this.pendingApprovals.has(prompt.id)) return;
    this.pendingApprovals.set(prompt.id, approval);
    this.#entry(`approval ${prompt.tool}`);
    this.#setSessionApprovalFlag(threadId);
  }

  #clearSessionApprovals(threadId) {
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.threadId === threadId) this.pendingApprovals.delete(id);
    }
  }

  #setSessionApprovalFlag(threadId) {
    const waiting = [...this.pendingApprovals.values()].some((approval) => approval.threadId === threadId);
    this.applyThread({
      id: threadId,
      status: { type: "active", activeFlags: waiting ? ["waitingOnApproval"] : [] },
    });
  }

  #totalOutputTokens() {
    let total = 0;
    for (const value of this.threadOutputTokens.values()) total += value;
    return total;
  }

  #recentlyCompleted() {
    return this.lastCompletedAt > 0 && this.now().getTime() - this.lastCompletedAt <= 3000;
  }

  #applyTokenUsage(params) {
    const totalOutput = params?.tokenUsage?.total?.outputTokens;
    if (typeof totalOutput === "number" && params.threadId) {
      this.threadOutputTokens.set(params.threadId, totalOutput);
    }

    const lastOutput = params?.tokenUsage?.last?.outputTokens;
    if (typeof lastOutput === "number" && params.turnId) {
      this.#rollDayIfNeeded();
      const previous = this.turnOutputTokens.get(params.turnId) || 0;
      if (lastOutput > previous) this.tokensToday += lastOutput - previous;
      this.turnOutputTokens.set(params.turnId, lastOutput);
    }
  }

  #applySessionTokenCount(info, event = {}) {
    const sourceId = event.sourceId || "desktop-session";
    const totalOutput = info?.total_token_usage?.output_tokens;
    if (typeof totalOutput === "number") {
      this.threadOutputTokens.set(sourceId, totalOutput);
    }

    const lastOutput = info?.last_token_usage?.output_tokens;
    this.#rollDayIfNeeded();
    const eventDay = event.timestamp ? this.#dayKey(new Date(event.timestamp)) : this.dayKey;
    if (eventDay !== this.dayKey) return;

    if (typeof totalOutput === "number") {
      const previousTotal = this.todayOutputTotals.get(sourceId);
      if (previousTotal === undefined) {
        const sessionStartedToday = !event.sessionDay || event.sessionDay === this.dayKey;
        this.tokensToday += sessionStartedToday ? totalOutput : Math.max(0, lastOutput || 0);
      } else if (totalOutput > previousTotal) {
        this.tokensToday += totalOutput - previousTotal;
      }
      this.todayOutputTotals.set(sourceId, totalOutput);
      return;
    }

    if (typeof lastOutput === "number") {
      this.tokensToday += lastOutput;
    }
  }

  #entry(text) {
    const value = squash(text);
    if (!value) return;
    const key = value.toLowerCase();
    if (this.entryKeys.includes(key)) return;
    const stamp = this.now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this.entries.unshift(`${stamp} ${truncate(value, 72)}`);
    this.entries = this.entries.slice(0, 8);
    this.entryKeys.unshift(key);
    this.entryKeys = this.entryKeys.slice(0, 8);
  }

  #rollDayIfNeeded() {
    const next = this.#dayKey();
    if (next === this.dayKey) return;
    this.dayKey = next;
    this.tokensToday = 0;
    this.turnOutputTokens.clear();
    this.todayOutputTotals.clear();
  }

  #dayKey() {
    const date = this.now();
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
}

function promptFromApproval(request) {
  const id = promptIdFor(request);
  const params = request.params || {};
  const approvalCorrelation = {
    threadId: typeof params.threadId === "string" ? params.threadId : "",
    turnId: typeof params.turnId === "string" ? params.turnId : "",
    command: approvalCommand(params),
    reason: typeof params.reason === "string" ? params.reason : "",
  };
  if (request.method === "item/commandExecution/requestApproval" || request.method === "execCommandApproval") {
    const network = params.networkApprovalContext;
    return {
      id,
      tool: network ? "Network" : "Bash",
      hint: truncate(network ? `${network.protocol || "net"} ${network.host}` : params.command || params.reason || params.cwd || "command", 43),
      approvalCorrelation,
    };
  }
  if (request.method === "item/fileChange/requestApproval" || request.method === "applyPatchApproval") {
    return {
      id,
      tool: "File edit",
      hint: truncate(params.grantRoot || params.reason || params.cwd || "apply patch", 43),
      approvalCorrelation,
    };
  }
  if (request.method === "item/permissions/requestApproval") {
    return {
      id,
      tool: "Permissions",
      hint: truncate(params.reason || params.cwd || "permissions", 43),
      approvalCorrelation,
    };
  }
  return { id, tool: "Approval", hint: "Codex request" };
}

function approvalCommand(params) {
  if (typeof params.command === "string") return params.command;
  const action = Array.isArray(params.commandActions)
    ? params.commandActions.find((candidate) => candidate && typeof candidate.command === "string")
    : null;
  return action?.command || "";
}

function sameApprovalContext(left, right) {
  const a = approvalContext(left);
  const b = approvalContext(right);
  if (!a.threadId || !b.threadId || a.threadId !== b.threadId) return false;
  if (!a.turnId || !b.turnId || a.turnId !== b.turnId) return false;
  if (left.tool !== right.tool) return false;
  if (a.command && b.command && a.command !== b.command) return false;
  if (a.reason && b.reason && a.reason !== b.reason) return false;
  return true;
}

function approvalContext(approval) {
  const correlation = approval.approvalCorrelation || approval.desktopCorrelation || {};
  return {
    threadId: normalizeApprovalThreadId(correlation.threadId || approval.threadId),
    turnId: correlation.turnId || "",
    command: correlation.command || "",
    reason: correlation.reason || "",
  };
}

function normalizeApprovalThreadId(value) {
  const threadId = typeof value === "string" ? value : "";
  return threadId.startsWith("desktop:") ? threadId.slice("desktop:".length) : threadId;
}

function promptIdFor(request) {
  const raw = String(request.id);
  if (raw.length <= 39) return raw;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 39);
}

function desktopCallFromPayload(payload) {
  const nestedCall = payload.type === "custom_tool_call" && payload.name === "exec"
    ? nestedToolCallFromExecInput(payload.input)
    : null;
  const effectivePayload = nestedCall
    ? { ...payload, name: nestedCall.name }
    : payload;
  const args = nestedCall?.args || parseToolArguments(payload.arguments);
  const prompt = desktopPromptFromToolCall(effectivePayload, args);
  return {
    id: payload.call_id || "",
    name: effectivePayload.name || "tool",
    args,
    prompt,
  };
}

// Newer Codex Desktop rollouts wrap tool calls in one free-form `exec` cell,
// so the session log no longer exposes the inner exec_command arguments as
// JSON. Parse only literal top-level string properties from nested
// `tools.<name>({ ... })` calls. Never evaluate session-log JavaScript.
function nestedToolCallFromExecInput(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const tokens = tokenizeJavascript(raw);
  for (let index = 0; index + 4 < tokens.length; index += 1) {
    if (
      tokens[index].type !== "identifier" || tokens[index].value !== "tools" ||
      tokens[index + 1].value !== "." ||
      tokens[index + 2].type !== "identifier" ||
      tokens[index + 3].value !== "(" ||
      tokens[index + 4].value !== "{"
    ) {
      continue;
    }
    const args = literalObjectStringProperties(tokens, index + 4);
    if (args?.sandbox_permissions === "require_escalated") {
      return { name: tokens[index + 2].value, args };
    }
  }
  return null;
}

function tokenizeJavascript(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const value = source[index];
    if (/\s/.test(value)) {
      index += 1;
      continue;
    }
    if (value === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (value === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (value === "\"" || value === "'" || value === "`") {
      const string = readJavascriptString(source, index);
      tokens.push({ type: "string", value: string.value });
      index = string.end;
      continue;
    }
    if (/[A-Za-z_$]/.test(value)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      tokens.push({ type: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ type: "punctuation", value });
    index += 1;
  }
  return tokens;
}

function readJavascriptString(source, start) {
  const quote = source[start];
  let value = "";
  let dynamic = false;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return { value: dynamic ? null : value, end: index + 1 };
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      dynamic = true;
    }
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    index += 1;
    if (index >= source.length) break;
    const escaped = source[index];
    const simpleEscapes = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      0: "\0",
    };
    if (escaped === "\n") {
      index += 1;
      continue;
    }
    if (escaped === "\r" && source[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (escaped === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCodePoint(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
      value += String.fromCodePoint(Number.parseInt(source.slice(index + 1, index + 5), 16));
      index += 5;
      continue;
    }
    value += Object.hasOwn(simpleEscapes, escaped) ? simpleEscapes[escaped] : escaped;
    index += 1;
  }
  return { value: null, end: source.length };
}

function literalObjectStringProperties(tokens, objectStart) {
  const properties = {};
  const stack = ["{"];
  for (let index = objectStart + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const atPropertyBoundary = index === objectStart + 1 || tokens[index - 1]?.value === ",";
    if (
      stack.length === 1 && atPropertyBoundary &&
      (token.type === "identifier" || token.type === "string")
    ) {
      const colon = tokens[index + 1];
      const literal = tokens[index + 2];
      if (token.value && colon?.value === ":" && literal?.type === "string" && literal.value !== null) {
        properties[token.value] = literal.value;
      }
    }
    if (token.value === "{" || token.value === "[" || token.value === "(") {
      stack.push(token.value);
      continue;
    }
    if (token.value === "}" || token.value === "]" || token.value === ")") {
      stack.pop();
      if (stack.length === 0) return properties;
    }
  }
  return null;
}

function desktopPromptFromToolCall(payload, args) {
  if (!args || args.sandbox_permissions !== "require_escalated") return null;
  const id = promptIdFor({ id: payload.call_id || JSON.stringify([payload.name, args]) });
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
  const command = args.cmd || args.command;
  const reason = args.justification;
  return {
    id,
    tool: toolLabel(payload.name),
    hint: truncate(args.justification || args.cmd || args.command || args.workdir || payload.name || "approval", 43),
    desktopCorrelation: {
      callId: typeof payload.call_id === "string" ? payload.call_id : "",
      turnId: typeof turnId === "string" ? turnId : "",
      command: typeof command === "string" ? command : "",
      reason: typeof reason === "string" ? reason : "",
    },
  };
}

function parseToolArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toolLabel(name = "") {
  const value = String(name);
  if (value === "exec_command" || value.endsWith(".exec_command")) return "Bash";
  if (value === "apply_patch" || value.endsWith(".apply_patch")) return "File edit";
  if (value.includes("request_plugin_install")) return "Plugin";
  if (value.includes("tool_search")) return "Tool search";
  return truncate(value.replace(/^functions\./, "").replace(/_/g, " ") || "Approval", 19);
}

function itemLine(item, completed) {
  if (!item?.type) return "";
  const suffix = completed ? "done" : "start";
  if (item.type === "commandExecution") return `${suffix} bash ${item.command || ""}`.trim();
  if (item.type === "fileChange") return `${suffix} file edit`;
  if (item.type === "mcpToolCall") return `${suffix} ${item.server}/${item.tool}`;
  if (item.type === "dynamicToolCall") return `${suffix} ${item.tool}`;
  if (item.type === "webSearch") return `${suffix} search ${item.query || ""}`.trim();
  if (item.type === "agentMessage" && item.text) return `msg ${item.text}`;
  return "";
}

function hasActiveFlag(thread, flag) {
  return thread?.status?.type === "active" && Array.isArray(thread.status.activeFlags) && thread.status.activeFlags.includes(flag);
}

function statusLabel(status) {
  if (!status) return "unknown";
  if (status.type !== "active") return status.type;
  return status.activeFlags?.length ? status.activeFlags.join(",") : "running";
}

function messageFor({ total, running, waiting }) {
  if (waiting > 0) return `waiting: ${waiting}`;
  if (running > 0) return `running: ${running}`;
  if (total > 0) return "Codex idle";
  return "No Codex connected";
}

export function petStateFor({ total = 0, running = 0, waiting = 0, completed = false } = {}) {
  if (waiting > 0) return "attention";
  if (completed) return "celebrate";
  if (running > 0) return "busy";
  if (total > 0) return "idle";
  return "sleep";
}

function shortThread(threadId = "") {
  return String(threadId).slice(0, 8) || "thread";
}

function truncate(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function squash(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(contentBlockText).filter(Boolean).join(" ");
}

function contentBlockText(block) {
  if (!block) return "";
  if (typeof block === "string") return block;
  if (typeof block.text === "string") return block.text;
  if (typeof block.output_text === "string") return block.output_text;
  if (typeof block.content === "string") return block.content;
  return "";
}

function shouldIgnoreSessionMessage(role, text) {
  if (role !== "user") return false;
  return /^<[^>\s]+[\s>]/.test(text);
}
