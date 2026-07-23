/** Runs a one-shot, five-minute OAuth callback listener bound only to IPv4 loopback. */
import { createServer } from "node:http";
import { assertState } from "../core/pkce.js";
import { AuthError, TransportError, type AuthSession, type PendingLogin, type TokenSet } from "../core/types.js";

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
      try { assertState(pending.state, callback.searchParams.get("state")); }
      catch {
        // Untrusted localhost probes must not cancel the real browser callback.
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(FAILURE);
        return;
      }
      const error = callback.searchParams.get("error");
      if (error !== null && error !== "") {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(FAILURE);
        finish(() => { reject(new AuthError("Authorization callback was rejected.")); });
        return;
      }
      const code = callback.searchParams.get("code");
      if (code === null || code === "") {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(FAILURE);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(SUCCESS);
      finish(() => { resolve(callback); });
    });
    const timeout = setTimeout(() => {
      finish(() => { reject(new TransportError("OAuth loopback callback timed out.")); });
    }, options.timeoutMs ?? 300_000);
    timeout.unref();
    server.once("error", (error) => { finish(() => { reject(new TransportError("OAuth loopback server failed.", { cause: error })); }); });
    server.listen(Number(port), "127.0.0.1");
  });
}

export interface LoginWithLoopbackOptions extends LoopbackOptions {
  /** Opens the authorize URL for the user. Defaults to logging `Open ${url}` via `console.log`. */
  open?: (url: string) => void | Promise<void>;
}

/**
 * Composes the whole loopback quickstart: begin login, hand the URL to `open`, wait for the
 * browser's callback, and complete it. The listener starts before `open` is invoked so a
 * fast-returning `open` can never race the callback it triggers.
 */
export async function loginWithLoopback(
  auth: AuthSession,
  subject: string,
  options: LoginWithLoopbackOptions = {},
): Promise<TokenSet> {
  const open = options.open ?? ((url: string) => { console.log(`Open ${url}`); });
  const pending = await auth.beginLogin();
  const callback = waitForLoopbackCallback(pending, options);
  await open(pending.url);
  return auth.completeLogin(subject, await callback, pending);
}
