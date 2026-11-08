import net from "node:net";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const MIN_LAN_TOKEN_LENGTH = 16;
const MAX_LAN_TOKEN_LENGTH = 96;
const VOICE_DATAGRAM_MAGIC = Buffer.from("XDV1", "ascii");
const VOICE_DATAGRAM_HEADER_BYTES = 18;
const VOICE_DATAGRAM_MAX_PCM_BYTES = 960;

export class DeviceConnection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.token = options.token || "";
    this.log = options.log || (() => {});
    this.maxFrameBytes = Number(options.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES);
    this.authTimeoutMs = Number(options.authTimeoutMs || DEFAULT_AUTH_TIMEOUT_MS);
    this.buffer = "";
    this.authenticated = !this.token;
    this.name = `${socket.remoteAddress}:${socket.remotePort}`;
    this.remoteAddress = normalizeIpAddress(socket.remoteAddress);
    this.authTimer = null;

    socket.setKeepAlive(true, 10_000);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => {
      this.#clearAuthTimer();
      this.emit("close");
    });
    socket.on("error", (error) => this.emit("error", error));

    if (!this.authenticated && this.authTimeoutMs > 0) {
      this.authTimer = setTimeout(() => {
        this.send({ ack: "hello", ok: false, error: "authentication timeout" });
        this.close();
      }, this.authTimeoutMs);
      this.authTimer.unref?.();
    }
  }

  send(payload) {
    if (this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(payload)}\n`);
  }

  close() {
    this.socket.end();
  }

  terminate() {
    this.socket.destroy();
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
          this.send({ ack: "parse", ok: false, error: "frame too large" });
          this.close();
        }
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        this.send({ ack: "parse", ok: false, error: "frame too large" });
        this.close();
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.send({ ack: "parse", ok: false, error: "invalid json" });
        continue;
      }

      if (!isPlainObject(message)) {
        this.send({ ack: "parse", ok: false, error: "message must be an object" });
        continue;
      }

      if (!this.authenticated) {
        if (message.token !== this.token) {
          this.send({ ack: "hello", ok: false, error: "bad token" });
          this.close();
          return;
        }
        this.authenticated = true;
        this.#clearAuthTimer();
        this.name = message.name || this.name;
        this.send({ ack: "hello", ok: true });
        this.emit("authenticated", message);
        continue;
      }

      if (message.name) this.name = message.name;
      this.emit("message", message);
    }
  }

  #clearAuthTimer() {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }
}

export class DeviceServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host ?? "127.0.0.1";
    this.port = Number(options.port ?? 8787);
    this.token = options.token || "";
    this.log = options.log || (() => {});
    this.maxFrameBytes = Number(options.maxFrameBytes || DEFAULT_MAX_FRAME_BYTES);
    this.authTimeoutMs = Number(options.authTimeoutMs || DEFAULT_AUTH_TIMEOUT_MS);
    this.server = null;
    this.udpSocket = null;
    this.connections = new Set();
  }

  async start() {
    if (this.server) return;
    if (!isLoopbackHost(this.host) && !isStrongLanToken(this.token)) {
      throw new Error(
        `CODEX_BUDDY_TOKEN must be ${MIN_LAN_TOKEN_LENGTH}-${MAX_LAN_TOKEN_LENGTH} URL-safe characters when the device server listens beyond loopback`,
      );
    }
    this.server = net.createServer((socket) => this.#handleSocket(socket));
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.port, this.host, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
      const address = this.server.address();
      if (!address || typeof address === "string") {
        throw new Error("device TCP server did not expose a listening port");
      }
      this.port = address.port;
      await this.#startUdp(address);
    } catch (error) {
      closeUdpSocket(this.udpSocket);
      this.udpSocket = null;
      this.server?.close();
      this.server = null;
      throw error;
    }
  }

  stop() {
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    closeUdpSocket(this.udpSocket);
    this.udpSocket = null;
    this.server?.close();
    this.server = null;
  }

  broadcast(payload) {
    for (const connection of this.connections) {
      if (connection.authenticated) connection.send(payload);
    }
  }

  get connectedCount() {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.authenticated) count += 1;
    }
    return count;
  }

  #handleSocket(socket) {
    const connection = new DeviceConnection(socket, {
      token: this.token,
      log: this.log,
      maxFrameBytes: this.maxFrameBytes,
      authTimeoutMs: this.authTimeoutMs,
    });
    this.connections.add(connection);
    this.emit("connection", connection);

    connection.on("authenticated", (message) => this.emit("authenticated", connection, message));
    connection.on("message", (message) => this.emit("message", message, connection));
    connection.on("close", () => {
      this.connections.delete(connection);
      this.emit("disconnect", connection);
    });
    connection.on("error", (error) => this.emit("deviceError", error, connection));

    if (!this.token) connection.emit("authenticated", { name: connection.name });
  }

  async #startUdp(tcpAddress) {
    const socketType = tcpAddress.family === "IPv6" ? "udp6" : "udp4";
    const socket = dgram.createSocket(socketType);
    this.udpSocket = socket;
    socket.on("message", (message, rinfo) => {
      const datagram = parseVoiceDatagram(message);
      if (!datagram) return;
      this.emit("datagram", datagram, {
        ...rinfo,
        address: normalizeIpAddress(rinfo.address),
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      socket.once("error", onError);
      socket.bind(this.port, tcpAddress.address, () => {
        socket.off("error", onError);
        resolve();
      });
    });
    socket.on("error", (error) => this.emit("deviceError", error));
  }
}

export function parseVoiceDatagram(message) {
  if (!Buffer.isBuffer(message) || message.length < VOICE_DATAGRAM_HEADER_BYTES) return null;
  if (!message.subarray(0, 4).equals(VOICE_DATAGRAM_MAGIC)) return null;

  for (let offset = 4; offset < 12; offset += 1) {
    const byte = message[offset];
    const isHex =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66);
    if (!isHex) return null;
  }
  const session = message.toString("ascii", 4, 12);
  const seq = message.readUInt32BE(12);
  const pcmLength = message.readUInt16BE(16);
  if (
    pcmLength === 0 ||
    pcmLength > VOICE_DATAGRAM_MAX_PCM_BYTES ||
    pcmLength % 2 !== 0 ||
    message.length !== VOICE_DATAGRAM_HEADER_BYTES + pcmLength
  ) {
    return null;
  }

  return {
    session: session.toLowerCase(),
    seq,
    pcm: Buffer.from(message.subarray(VOICE_DATAGRAM_HEADER_BYTES)),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isStrongLanToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9._~-]{16,96}$/.test(token);
}

function normalizeIpAddress(address) {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function closeUdpSocket(socket) {
  if (!socket) return;
  try {
    socket.close();
  } catch (error) {
    if (error?.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
  }
}
