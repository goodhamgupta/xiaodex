#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const rotate = process.argv.includes("--rotate");
const pathArgument = process.argv.slice(2).find((argument) => argument !== "--rotate");
const envPath = path.resolve(pathArgument || ".env");
const key = "CODEX_BUDDY_TOKEN";
const validToken = /^[A-Za-z0-9._~-]{16,96}$/;

let source = "";
try {
  source = fs.readFileSync(envPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const existing = source
  .split(/\r?\n/)
  .find((line) => line.startsWith(`${key}=`))
  ?.slice(key.length + 1)
  .replace(/^(['"])(.*)\1$/, "$2");

if (!rotate && validToken.test(existing || "")) {
  fs.chmodSync(envPath, 0o600);
  console.log("Bridge token already configured in .env.");
  process.exit(0);
}

const token = crypto.randomBytes(32).toString("base64url");
const lines = source
  .split(/\r?\n/)
  .filter((line) => !line.startsWith(`${key}=`));
while (lines.at(-1) === "") lines.pop();
lines.push(`${key}=${token}`, "");

const temporaryPath = `${envPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPath, lines.join("\n"), { mode: 0o600 });
fs.renameSync(temporaryPath, envPath);
fs.chmodSync(envPath, 0o600);
console.log("Generated a new bridge token in .env.");
