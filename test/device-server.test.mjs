import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import readline from "node:readline";
import { DeviceServer, parseVoiceDatagram } from "../src/mac/device-server.mjs";

test("authenticates device and sends newline-delimited JSON", async () => {
  const server = new DeviceServer({ host: "127.0.0.1", port: 0, token: "secret" });
  await server.start();
  const port = server.server.address().port;

  const socket = net.createConnection({ host: "127.0.0.1", port });
  const lines = readline.createInterface({ input: socket });
  const received = [];
  lines.on("line", (line) => received.push(JSON.parse(line)));

  socket.write(`${JSON.stringify({ token: "secret", name: "test-device" })}\n`);
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { ack: "hello", ok: true });

  server.broadcast({ total: 1, running: 0, waiting: 0 });
  await waitFor(() => received.length === 2);
  assert.equal(received[1].total, 1);

  socket.end();
  server.stop();
});

test("rejects non-object JSON without crashing the connection", async () => {
  const server = new DeviceServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  const port = server.server.address().port;
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const lines = readline.createInterface({ input: socket });
  const received = [];
  lines.on("line", (line) => received.push(JSON.parse(line)));

  socket.write("null\n");
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { ack: "parse", ok: false, error: "message must be an object" });

  socket.write(`${JSON.stringify({ cmd: "status" })}\n`);
  const message = await onceEvent(server, "message");
  assert.equal(message[0].cmd, "status");

  socket.end();
  server.stop();
});

test("closes a connection whose JSONL frame exceeds the byte limit", async () => {
  const server = new DeviceServer({ host: "127.0.0.1", port: 0, maxFrameBytes: 32 });
  await server.start();
  const port = server.server.address().port;
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const lines = readline.createInterface({ input: socket });
  const received = [];
  lines.on("line", (line) => received.push(JSON.parse(line)));
  const closed = onceEvent(socket, "close");

  socket.write("x".repeat(33));
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], { ack: "parse", ok: false, error: "frame too large" });
  await closed;

  server.stop();
});

test("requires a strong URL-safe token for non-loopback listeners", async () => {
  for (const token of ["", "too-short", "x".repeat(97), "not safe but long enough"]) {
    const server = new DeviceServer({ host: "0.0.0.0", port: 0, token });
    await assert.rejects(
      () => server.start(),
      /CODEX_BUDDY_TOKEN must be 16-96 URL-safe characters/,
    );
  }
});

test("binds raw voice UDP to the actual TCP port and emits parsed PCM", async (t) => {
  const server = new DeviceServer({ host: "127.0.0.1", port: 0 });
  await server.start();
  t.after(() => server.stop());

  const tcpPort = server.server.address().port;
  assert.equal(server.port, tcpPort);
  assert.equal(server.udpSocket.address().port, tcpPort);

  const pcm = Buffer.from([1, 0, 2, 0]);
  const received = onceEvent(server, "datagram");
  const client = dgram.createSocket("udp4");
  t.after(() => client.close());
  await sendDatagram(client, voiceDatagram("a1b2c3d4", 7, pcm), tcpPort);

  const [datagram, rinfo] = await received;
  assert.equal(datagram.session, "a1b2c3d4");
  assert.equal(datagram.seq, 7);
  assert.deepEqual(datagram.pcm, pcm);
  assert.equal(rinfo.address, "127.0.0.1");
});

test("rejects malformed or oversized raw voice datagrams", () => {
  const valid = voiceDatagram("a1b2c3d4", 0, Buffer.alloc(960));
  assert.equal(parseVoiceDatagram(valid).pcm.length, 960);
  assert.equal(parseVoiceDatagram(Buffer.from("wrong")), null);

  const oddPcm = voiceDatagram("a1b2c3d4", 0, Buffer.from([1]));
  assert.equal(parseVoiceDatagram(oddPcm), null);
  const oversized = voiceDatagram("a1b2c3d4", 0, Buffer.alloc(962));
  assert.equal(parseVoiceDatagram(oversized), null);
  const trailing = Buffer.concat([voiceDatagram("a1b2c3d4", 0, Buffer.alloc(2)), Buffer.alloc(2)]);
  assert.equal(parseVoiceDatagram(trailing), null);

  const highBitMagic = Buffer.from(valid);
  highBitMagic[0] |= 0x80;
  assert.equal(parseVoiceDatagram(highBitMagic), null);
  const highBitSession = Buffer.from(valid);
  highBitSession[4] |= 0x80;
  assert.equal(parseVoiceDatagram(highBitSession), null);
});

function onceEvent(emitter, name) {
  return new Promise((resolve, reject) => {
    emitter.once(name, (...args) => resolve(args));
    emitter.once("error", reject);
  });
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function voiceDatagram(session, seq, pcm) {
  const header = Buffer.alloc(18);
  header.write("XDV1", 0, "ascii");
  header.write(session, 4, "ascii");
  header.writeUInt32BE(seq, 12);
  header.writeUInt16BE(pcm.length, 16);
  return Buffer.concat([header, pcm]);
}

function sendDatagram(socket, message, port) {
  return new Promise((resolve, reject) => {
    socket.send(message, port, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
