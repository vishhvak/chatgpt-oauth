/** Covers hostile loopback probes and tolerant token normalization. */
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AuthError, createAuthSession, createMemoryStore, type PendingLogin } from "../src/index.js";
import { loginWithLoopback, waitForLoopbackCallback } from "../src/node/index.js";
import { redact } from "../src/core/redact.js";

const pending = (port: number): PendingLogin => ({
  url: "https://auth.example/authorize",
  state: "expected-state",
  verifier: "verifier",
  redirectUri: `http://localhost:${port}/auth/callback`,
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port.");
  await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  return address.port;
}

describe("OAuth edge cases", () => {
  it("ignores invalid and mismatched loopback probes until a valid callback arrives", async () => {
    const port = await unusedPort();
    const waiting = waitForLoopbackCallback(pending(port), { port, timeoutMs: 1_000 });
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    const missingState = await fetch(`http://127.0.0.1:${port}/auth/callback?code=probe`);
    expect(missingState.status).toBe(400);
    const wrongState = await fetch(`http://127.0.0.1:${port}/auth/callback?state=wrong&error=access_denied`);
    expect(wrongState.status).toBe(400);
    const missingResult = await fetch(`http://127.0.0.1:${port}/auth/callback?state=expected-state`);
    expect(missingResult.status).toBe(400);
    const emptyError = await fetch(`http://127.0.0.1:${port}/auth/callback?state=expected-state&error=`);
    expect(emptyError.status).toBe(400);

    const validUrl = `http://127.0.0.1:${port}/auth/callback?state=expected-state&code=real-code`;
    const valid = await fetch(validUrl);
    expect(valid.status).toBe(200);
    const callback = await waiting;
    expect(callback.pathname).toBe("/auth/callback");
    expect(callback.searchParams.get("state")).toBe("expected-state");
    expect(callback.searchParams.get("code")).toBe("real-code");
  });

  it("settles a loopback OAuth error only when its state matches", async () => {
    const port = await unusedPort();
    const waiting = waitForLoopbackCallback(pending(port), { port, timeoutMs: 1_000 });
    const rejection = expect(waiting).rejects.toBeInstanceOf(AuthError);
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?state=expected-state&error=access_denied`);
    expect(response.status).toBe(400);
    await rejection;
  });

  it("loginWithLoopback composes beginLogin, open, the loopback listener, and completeLogin", async () => {
    const port = await unusedPort();
    const store = createMemoryStore();
    const auth = createAuthSession({
      store,
      fetch: async () => Response.json({ access_token: "access-loopback", refresh_token: "refresh-loopback", expires_in: 3_600 }),
    });
    const opened: string[] = [];

    const tokens = await loginWithLoopback(auth, "loopback-user", {
      port,
      timeoutMs: 1_000,
      open: async (url) => {
        opened.push(url);
        const state = new URL(url).searchParams.get("state") ?? "";
        // The listener starts before `open` is awaited, so this callback is never racing it.
        await fetch(`http://127.0.0.1:${port}/auth/callback?state=${state}&code=real-code`);
      },
    });

    expect(opened).toHaveLength(1);
    expect(tokens.accessToken).toBe("access-loopback");
    expect((await store.load("loopback-user"))?.accessToken).toBe("access-loopback");
  });

  it("redacts a bare JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcHAtdXNlci00MiJ9.signature_value";
    const scrubbed = redact(`upstream returned ${jwt}`);
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("coerces string expires_in values and safely expires non-finite values", async () => {
    const now = 1_000;
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "access-string", refresh_token: "refresh", expires_in: "3600" }))
      .mockResolvedValueOnce(Response.json({ access_token: "access-invalid", refresh_token: "refresh", expires_in: "not-a-number" }))
      .mockResolvedValueOnce(Response.json({ access_token: "access-overflow", refresh_token: "refresh", expires_in: "1e308" }));
    const session = createAuthSession({ store: createMemoryStore(), fetch: request as typeof fetch, now: () => now });
    const login = pending(1455);

    await expect(session.completeLogin("string-expiry", `http://localhost:1455/auth/callback?state=${login.state}&code=one`, login))
      .resolves.toMatchObject({ expiresAt: now + 3_600_000 });
    await expect(session.completeLogin("invalid-expiry", `http://localhost:1455/auth/callback?state=${login.state}&code=two`, login))
      .resolves.toMatchObject({ expiresAt: now });
    await expect(session.completeLogin("overflow-expiry", `http://localhost:1455/auth/callback?state=${login.state}&code=three`, login))
      .resolves.toMatchObject({ expiresAt: now });
  });
});
