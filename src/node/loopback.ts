/** Runs a one-shot, five-minute OAuth callback listener bound only to IPv4 loopback. */
import { createServer } from "node:http";
import { assertState } from "../core/pkce.js";
import { AuthError, TransportError, type PendingLogin } from "../core/types.js";

const SUCCESS = "<!doctype html><meta charset=utf-8><title>Signed in</title><h1>Sign-in complete</h1><p>You may close this window.</p>";
const FAILURE = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title><h1>Sign-in failed</h1><p>Return to the application and try again.</p>";

export interface LoopbackOptions {
  timeoutMs?: number;
  port?: number;
}

export function waitForLoopbackCallback(pending: PendingLogin, options: LoopbackOptions = {}): Promise<URL> {
  const port = options.port ?? new URL(pending.redirectUri).port;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      operation();
    };
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", `http://localhost:${port}`);
      if (callback.pathname !== "/auth/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      try {
        // Validate state before reading code/error to keep every attacker path equivalent.
        assertState(pending.state, callback.searchParams.get("state"));
        const error = callback.searchParams.get("error");
        const code = callback.searchParams.get("code");
        if (error !== null || code === null || code === "") throw new AuthError("Authorization callback was rejected.");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(SUCCESS);
        finish(() => { resolve(callback); });
      } catch (error) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(FAILURE);
        finish(() => { reject(error); });
      }
    });
    const timeout = setTimeout(() => {
      finish(() => { reject(new TransportError("OAuth loopback callback timed out.")); });
    }, options.timeoutMs ?? 300_000);
    timeout.unref();
    server.once("error", (error) => { finish(() => { reject(new TransportError("OAuth loopback server failed.", { cause: error })); }); });
    server.listen(Number(port), "127.0.0.1");
  });
}
