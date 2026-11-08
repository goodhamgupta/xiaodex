import net from "node:net";
import readline from "node:readline";

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 8787);
const token = process.env.CODEX_BUDDY_TOKEN || "";
let lastPromptId = "";

const socket = net.createConnection({ host, port }, () => {
  socket.write(`${JSON.stringify({ name: "simulated-codex-buddy", token })}\n`);
});

const rl = readline.createInterface({ input: socket });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  console.log("<", JSON.stringify(message));
  if (message.prompt) {
    lastPromptId = message.prompt.id;
    console.log(`Prompt ${message.prompt.id}: ${message.prompt.tool} ${message.prompt.hint}`);
    console.log("Type 'a' to approve or 'd' to deny.");
  }
});

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", (_str, key) => {
  if (key.name === "c" && key.ctrl) process.exit(0);
  if (key.name !== "a" && key.name !== "d") return;
  socket.write(`${JSON.stringify({
    cmd: "permission",
    id: lastPromptId,
    decision: key.name === "d" ? "deny" : "once",
  })}\n`);
});
