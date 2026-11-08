import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

const DEFAULT_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";

export class CodexJsonRpcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin = options.codexBin || (existsSync(DEFAULT_CODEX_BIN) ? DEFAULT_CODEX_BIN : "codex");
    this.args = options.args || ["app-server", "--listen", "stdio://"];
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.clientInfo = {
      name: "codex_buddy",
      title: "Codex Buddy",
      version: "0.1.0",
      ...(options.clientInfo || {}),
    };
    this.log = options.log || (() => {});
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 15000);
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.codexBin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.once("exit", (code, signal) => {
      const tail = this.stderrTail.slice(-20).join("\n");
      const error = new Error(`codex app-server exited code=${code} signal=${signal}${tail ? `\nstderr:\n${tail}` : ""}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal, stderrTail: [...this.stderrTail] });
      this.proc = null;
    });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocolError", new Error(`invalid app-server JSON: ${line}`));
        return;
      }
      this.#handleMessage(message);
    });

    createInterface({ input: this.proc.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 80) this.stderrTail.shift();
      this.emit("stderr", line);
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return result;
  }

  request(method, params = {}) {
    if (!this.proc?.stdin) throw new Error("codex app-server is not running");
    const id = String(this.nextId++);
    this.#write({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result = {}) {
    this.#write({ id, result });
  }

  rejectRequest(id, code, message, data = null) {
    this.#write({ id, error: { code, message, data } });
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.stdin?.end();
    proc.kill("SIGTERM");
  }

  #handleMessage(message) {
    if (message && typeof message === "object" && "method" in message && "id" in message) {
      this.emit("serverRequest", message);
      return;
    }

    if (message && typeof message === "object" && "method" in message) {
      this.emit("notification", message);
      return;
    }

    const id = String(message?.id ?? "");
    const pending = this.pending.get(id);
    if (!pending) {
      this.emit("orphanResponse", message);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error) {
      const error = new Error(message.error.message || `${pending.method} failed`);
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  #write(payload) {
    if (!this.proc?.stdin) throw new Error("codex app-server is not running");
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }
}
