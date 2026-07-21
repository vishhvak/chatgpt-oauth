#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal";
const wireFile = process.env.FAKE_WIRE_FILE;
const envFile = process.env.FAKE_ENV_FILE;
const pidFile = process.env.FAKE_PID_FILE;
let initialized = false;
let buffer = "";
let overloadAttempts = 0;

if (process.argv.slice(2).join("|") !== 'app-server|-c|cli_auth_credentials_store="ephemeral"') {
  process.stderr.write("unexpected invocation");
  process.exit(2);
}

if (envFile !== undefined) {
  writeFileSync(envFile, JSON.stringify({
    keys: Object.keys(process.env).sort(),
    githubToken: process.env.GITHUB_TOKEN ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
    argv: process.argv.slice(2),
  }));
}

if (scenario === "teardown") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (pidFile !== undefined) writeFileSync(pidFile, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completed(status = "completed", error = null) {
  send({ method: "turn/completed", params: {
    threadId: "thread-1",
    turn: { id: "turn-1", status, error },
  } });
}

function finishTurn(text = "hello") {
  send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1" } } });
  send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: text } });
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1" } } });
  completed();
}

function handle(message) {
  if (message.id === 900 && message.method === undefined) {
    if (scenario === "refresh" && message.result?.accessToken === "access-fresh") finishTurn("fresh answer");
    if (scenario === "refresh-error" && message.error !== undefined) completed("failed", { message: "external refresh failed" });
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: process.env.CODEX_HOME } });
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if (!initialized) {
    if (message.id !== undefined) send({ id: message.id, error: { code: -32000, message: "Not initialized" } });
    return;
  }
  if (message.method === "account/login/start") {
    send({ id: message.id, result: { type: "chatgptAuthTokens" } });
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "overloaded") {
      overloadAttempts += 1;
      send({ id: message.id, error: { code: -32001, message: `overloaded-${overloadAttempts}` } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thread-1" }, model: message.params?.model } });
    send({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    if (scenario === "refresh" || scenario === "refresh-error") {
      send({ id: 900, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "account-old" } });
    } else finishTurn();
    return;
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "method not found" } });
}

process.stdin.on("data", (chunk) => {
  if (wireFile !== undefined) appendFileSync(wireFile, chunk);
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line !== "") handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  if (scenario !== "teardown") process.exitCode = 0;
});
