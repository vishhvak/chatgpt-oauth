/** Runs the copy-and-own HTTP service that joins app auth, Postgres, and Codex. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createAuthSession, type PendingLogin, type ResponseRequest } from "chatgpt-oauth";
import { createAppServerClient } from "chatgpt-oauth/app-server";
import { requireDemoSubject } from "./demo-session.js";
import { createPostgresCredentialStore } from "./postgres-store.js";
import { SessionManager } from "./session-manager.js";

function requiredEnv(name: "DATABASE_URL" | "CHATGPT_OAUTH_KEY" | "SESSION_SECRET"): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function requestShape(body: Record<string, unknown>): ResponseRequest {
  if (typeof body.model !== "string" || typeof body.input !== "string") {
    throw new Error("model and input must be strings.");
  }
  return {
    model: body.model,
    input: body.input,
    ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
  };
}

const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`);
const sessionSecret = requiredEnv("SESSION_SECRET");
if (Buffer.byteLength(sessionSecret) < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes.");
const store = await createPostgresCredentialStore({
  connectionString: requiredEnv("DATABASE_URL"),
  encryptionKey: requiredEnv("CHATGPT_OAUTH_KEY"),
});
const auth = createAuthSession({ store });
const sessions = new SessionManager({
  createClient: (subject) => createAppServerClient(auth, subject),
});
const pending = new Map<string, { login: PendingLogin; expiresAt: number }>();
const loginTtlMs = 5 * 60_000;
const clientBundle = readFile(new URL("../public/client.global.js", import.meta.url));

const demoHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT OAuth demo</title></head>
<body><div id="app"></div><script defer src="/assets/client.js"></script></body>
</html>`;

const callbackHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title></head>
<body><p>ChatGPT connected. You can close this window.</p><script>window.close();setTimeout(function(){location.replace('/')},150)</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", publicUrl);
  const subject = requireDemoSubject(request, response, sessionSecret, publicUrl.protocol === "https:");
  try {
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(demoHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/assets/client.js") {
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
      response.end(await clientBundle);
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/login") {
      const redirectUri = new URL("/auth/callback", publicUrl).toString();
      const login = await auth.beginLogin(redirectUri);
      pending.set(subject, { login, expiresAt: Date.now() + loginTtlMs });
      json(response, 200, { url: login.url });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      const saved = pending.get(subject);
      pending.delete(subject);
      if (saved === undefined || saved.expiresAt < Date.now()) {
        json(response, 400, { error: "Login expired. Start again." });
        return;
      }
      await auth.completeLogin(subject, url, saved.login);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(callbackHtml);
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      pending.delete(subject);
      await Promise.all([auth.logout(subject), sessions.drop(subject)]);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/session") {
      const current = await auth.status(subject);
      json(response, 200, current === null
        ? { status: "disconnected" }
        : { status: current.status, email: current.email ?? null, planType: current.planType ?? null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/chatgpt/usage") {
      if (await auth.status(subject) === null) {
        json(response, 401, { error: "Sign in with ChatGPT to view usage." });
        return;
      }
      json(response, 200, await sessions.getRateLimits(subject));
      return;
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      const chatRequest = requestShape(await readJson(request));
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      await sessions.run(subject, async (client) => {
        for await (const event of client.stream(chatRequest)) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 500;
    if (!response.headersSent) json(response, status, { error: status === 400 ? "Invalid JSON." : "Request failed." });
    else response.destroy();
    console.error(error instanceof Error ? error.name : "UnknownError");
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const serverClosed = new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await sessions.close();
  await serverClosed;
  await store.close();
}

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
