/** Pins the twelve security and concurrency invariants required for the v1 contract. */
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuthError,
  DisabledError,
  RateLimitError,
  ReauthRequiredError,
  StateMismatchError,
  StoreError,
  createAuthSession,
  createClient,
  createMemoryStore,
  type AuthSession,
  type CredentialStore,
  type TokenSet,
} from "../src/index.js";
import { createFileStore } from "../src/node/index.js";
import { createPkce, pkceChallenge } from "../src/core/pkce.js";
import { redact } from "../src/core/redact.js";
import { parseSSE } from "../src/core/sse.js";

const subject = "app-user-42";

function token(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 1,
    version: 1,
    ...overrides,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3_600, ...overrides });
}

function streamResponse(parts: string[], status = 200, headers: HeadersInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

function fakeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  // `session` is captured by closure so getTokenSet always sees the final, overridden methods below.
  const session: AuthSession = {
    async beginLogin() { throw new Error("unused"); },
    async completeLogin() { throw new Error("unused"); },
    async startDeviceLogin() { throw new Error("unused"); },
    async getAccessToken() { return "access-old"; },
    async refreshAccessToken() { return "access-new"; },
    async getTokenSet(subj, forceRefresh) {
      const accessToken = forceRefresh ? await session.refreshAccessToken(subj) : await session.getAccessToken(subj);
      const status = await session.status(subj);
      return {
        accessToken,
        refreshToken: "unused-refresh-token",
        expiresAt: Date.now(),
        version: 1,
        ...(status?.accountId === undefined ? {} : { accountId: status.accountId }),
      };
    },
    async status() { return { subject, status: "connected", expiresAt: Date.now(), accountId: "account-route" }; },
    async logout() {},
    ...overrides,
  };
  return session;
}

describe("v1 invariants", () => {
  it("1. generates base64url PKCE/state and computes the known S256 vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const generated = await createPkce();
    expect(generated.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(generated.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(generated.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("2. rejects mismatched callback state before attempting token exchange", async () => {
    const request = vi.fn();
    const session = createAuthSession({ store: createMemoryStore(), fetch: request as unknown as typeof fetch });
    const pending = await session.beginLogin("https://app.example/callback");
    await expect(session.completeLogin(subject, "https://app.example/callback?state=wrong&code=secret", pending))
      .rejects.toBeInstanceOf(StateMismatchError);
    expect(request).not.toHaveBeenCalled();
  });

  it("3. collapses 20 concurrent expired-token calls into one refresh POST", async () => {
    const store = createMemoryStore({ [subject]: token() });
    const request = vi.fn(async () => tokenResponse());
    const session = createAuthSession({ store, fetch: request as unknown as typeof fetch, now: () => 10_000 });
    const values = await Promise.all(Array.from({ length: 20 }, () => session.getAccessToken(subject)));
    expect(new Set(values)).toEqual(new Set(["access-new"]));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("forces a refresh when joining a non-force flight that adopts a store rotation", async () => {
    let current = token({ expiresAt: 10_500 });
    let loadCount = 0;
    let releaseFlightLoad!: () => void;
    const flightLoadStarted = new Promise<void>((resolve) => {
      releaseFlightLoad = resolve;
    });
    let unblockFlightLoad!: () => void;
    const flightLoadBlocked = new Promise<void>((resolve) => {
      unblockFlightLoad = resolve;
    });
    const store: CredentialStore = {
      async load() {
        loadCount += 1;
        if (loadCount === 2) {
          releaseFlightLoad();
          await flightLoadBlocked;
        }
        return structuredClone(current);
      },
      async compareAndSwap(_subject, expectedVersion, next) {
        if (current.version !== expectedVersion) return { ok: false, current: structuredClone(current) };
        current = { ...next, version: expectedVersion + 1 };
        return { ok: true, current: structuredClone(current) };
      },
      async delete() {},
    };
    const request = vi.fn(async () => tokenResponse({ access_token: "access-forced" }));
    const session = createAuthSession({ store, fetch: request as unknown as typeof fetch, now: () => 10_000 });

    const opportunistic = session.getAccessToken(subject);
    await flightLoadStarted;
    const forced = session.refreshAccessToken(subject);
    current = token({ accessToken: "access-rotated", refreshToken: "refresh-rotated", expiresAt: 9_999_999, version: 2 });
    unblockFlightLoad();

    await expect(Promise.all([opportunistic, forced])).resolves.toEqual(["access-rotated", "access-forced"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("4. adopts a CAS winner when another process rotates during refresh", async () => {
    let current = token();
    const winner = token({ accessToken: "winner-access", refreshToken: "winner-refresh", expiresAt: 9_999_999, version: 2 });
    const store: CredentialStore = {
      async load() { return structuredClone(current); },
      async compareAndSwap(_subject, expectedVersion, next) {
        if (current.version !== expectedVersion) return { ok: false, current: structuredClone(current) };
        current = { ...next, version: expectedVersion + 1 };
        return { ok: true, current: structuredClone(current) };
      },
      async delete() {},
    };
    const request = vi.fn(async () => { current = winner; return tokenResponse({ access_token: "loser-access" }); });
    const session = createAuthSession({ store, fetch: request as unknown as typeof fetch, now: () => 10_000 });
    await expect(session.getAccessToken(subject)).resolves.toBe("winner-access");
    expect(request).toHaveBeenCalledTimes(1);

    let quarantined = token();
    const quarantinedStore: CredentialStore = {
      async load() { return structuredClone(quarantined); },
      async compareAndSwap(_subject, expectedVersion, next) {
        if (quarantined.version !== expectedVersion) return { ok: false, current: structuredClone(quarantined) };
        quarantined = { ...next, version: expectedVersion + 1 };
        return { ok: true, current: structuredClone(quarantined) };
      },
      async delete() {},
    };
    const quarantinedRequest = vi.fn(async () => {
      quarantined = token({ version: 2, quarantinedAt: 9_000, quarantineReason: "invalid_grant" });
      return tokenResponse();
    });
    const losingSession = createAuthSession({
      store: quarantinedStore,
      fetch: quarantinedRequest as unknown as typeof fetch,
      now: () => 10_000,
    });
    await expect(losingSession.getAccessToken(subject)).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("5. retains the old refresh token when rotation is omitted", async () => {
    const store = createMemoryStore({ [subject]: token() });
    const request = vi.fn(async () => tokenResponse({ refresh_token: undefined }));
    const session = createAuthSession({ store, fetch: request as unknown as typeof fetch, now: () => 10_000 });
    await session.getAccessToken(subject);
    expect((await store.load(subject))?.refreshToken).toBe("refresh-old");
  });

  it("6. quarantines invalid_grant permanently but never quarantines 429", async () => {
    const terminalStore = createMemoryStore({ [subject]: token() });
    const terminalRequest = vi.fn(async () => Response.json({ padding: "x".repeat(1_100), error: "invalid_grant" }, { status: 400 }));
    const terminal = createAuthSession({ store: terminalStore, fetch: terminalRequest as unknown as typeof fetch, now: () => 10_000 });
    await expect(terminal.getAccessToken(subject)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect((await terminalStore.load(subject))?.quarantineReason).toBe("invalid_grant");
    await expect(terminal.getAccessToken(subject)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(terminalRequest).toHaveBeenCalledTimes(1);

    const limitedStore = createMemoryStore({ [subject]: token() });
    const limitedRequest = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "3" } }));
    const limited = createAuthSession({
      store: limitedStore,
      fetch: limitedRequest as unknown as typeof fetch,
      now: () => 10_000,
      sleep: async () => undefined,
    });
    await expect(limited.getAccessToken(subject)).rejects.toBeInstanceOf(RateLimitError);
    expect((await limitedStore.load(subject))?.quarantinedAt).toBeUndefined();
    expect(limitedRequest).toHaveBeenCalledTimes(3);

    const transientStore = createMemoryStore({ [subject]: token() });
    const transientRequest = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(tokenResponse());
    const transient = createAuthSession({
      store: transientStore,
      fetch: transientRequest as unknown as typeof fetch,
      now: () => 10_000,
      sleep: async () => undefined,
    });
    await expect(transient.getAccessToken(subject)).resolves.toBe("access-new");
    expect(transientRequest).toHaveBeenCalledTimes(3);
    expect((await transientStore.load(subject))?.quarantinedAt).toBeUndefined();
  });

  it("7. refreshes and retries inference once on 401, then surfaces a typed second 401", async () => {
    const refresh = vi.fn(async () => "access-new");
    const successfulFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(streamResponse(["event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"]));
    const client = createClient(fakeSession({ refreshAccessToken: refresh }), subject, { fetch: successfulFetch as typeof fetch });
    await expect(client.respond({ model: "gpt-test", input: "hello" })).resolves.toMatchObject({ outputText: "" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(successfulFetch).toHaveBeenCalledTimes(2);

    const rejectedFetch = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const rejected = createClient(fakeSession({ refreshAccessToken: refresh }), subject, { fetch: rejectedFetch as unknown as typeof fetch });
    await expect(rejected.respond({ model: "gpt-test", input: "hello" })).rejects.toBeInstanceOf(AuthError);
    expect(rejectedFetch).toHaveBeenCalledTimes(2);

    const retryDate = new Date(Date.now() + 5_000).toUTCString();
    const limited = createClient(fakeSession(), subject, {
      fetch: vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": retryDate } })) as unknown as typeof fetch,
    });
    const limitedError = await limited.respond({ model: "gpt-test", input: "hello" }).catch((caught: unknown) => caught);
    expect(limitedError).toBeInstanceOf(RateLimitError);
    expect((limitedError as RateLimitError).retryAfterMs).toBeGreaterThan(0);
  });

  it("8. parses chunk-split, multiline, done, and unknown SSE events", async () => {
    const response = streamResponse([
      "event: response.output_",
      "text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
      "event: future.event\ndata: first\ndata: second\n\n",
      "data: [DO",
      "NE]\r",
      "\n\r\n",
      "event: ignored\ndata: after\n\n",
    ]);
    const events = [];
    if (response.body === null) throw new Error("missing fixture body");
    for await (const event of parseSSE(response.body)) events.push(event);
    expect(events).toEqual([
      { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hi" }, delta: "Hi" },
      { type: "future.event", data: "first\nsecond" },
    ]);
  });

  it("9. redacts bearer credentials from transport error messages", async () => {
    const secret = "sk-secret-access-value";
    const longSecret = "s".repeat(1_500);
    const request = vi.fn(async () => new Response(
      `failure Authorization: Bearer ${secret} {"access_token":"${longSecret}"}`,
      { status: 500 },
    ));
    const client = createClient(fakeSession(), subject, { fetch: request as unknown as typeof fetch });
    const error = await client.respond({ model: "gpt-test", input: "hello" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(longSecret.slice(0, 500));
    expect((error as Error).message).toContain("[REDACTED]");

    const fetchSecret = "sk-fetch-secret";
    const rejected = createClient(fakeSession(), subject, {
      fetch: vi.fn(async () => { throw new Error(`network Bearer ${fetchSecret}`); }) as unknown as typeof fetch,
    });
    const rejectedError = await rejected.respond({ model: "gpt-test", input: "hello" }).catch((caught: unknown) => caught);
    expect(rejectedError).toMatchObject({ code: "transport" });
    expect((rejectedError as Error).message).not.toContain(fetchSecret);
    const quoted = redact(JSON.stringify({ access_token: "abc'def", refresh_token: 'abc"def' }));
    expect(quoted).not.toContain("abc'def");
    expect(quoted).not.toContain('abc\\"def');
    expect(redact(`{"access_token":"SECRET\\`)).not.toContain("SECRET");
  });

  it("10. enforces Node modes, encrypted roundtrip, and typed tamper failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-oauth-test-"));
    try {
      const store = await createFileStore({ directory, env: {} });
      const staleLock = join(directory, "credentials.lock");
      await writeFile(staleLock, "", { mode: 0o600 });
      await utimes(staleLock, new Date(0), new Date(0));
      await writeFile(`${staleLock}.reaper`, "999999:dead", { mode: 0o600 });
      const saved = await store.compareAndSwap(subject, 0, token({ version: 99 }));
      expect(saved.current?.version).toBe(1);
      expect(await store.load(subject)).toMatchObject({ accessToken: "access-old", version: 1 });
      await expect(store.compareAndSwap("__proto__", 0, token())).resolves.toMatchObject({ ok: true });
      expect(await store.load("__proto__")).toMatchObject({ accessToken: "access-old", version: 1 });
      expect({
        directory: (await stat(directory)).mode & 0o777,
        data: (await stat(join(directory, "credentials.enc"))).mode & 0o777,
        key: (await stat(join(directory, "credentials.key"))).mode & 0o777,
      }).toEqual({ directory: 0o700, data: 0o600, key: 0o600 });
      const dataFile = join(directory, "credentials.enc");
      const envelope = await readFile(dataFile, "utf8");
      expect(envelope).not.toContain("access-old");
      await writeFile(dataFile, `${envelope.slice(0, -1)}A`);
      await chmod(dataFile, 0o600);
      await expect(store.load(subject)).rejects.toBeInstanceOf(StoreError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("11. requires a subject argument on every CredentialStore method", () => {
    const store = createMemoryStore();
    const subjectRequired = () => {
      // @ts-expect-error subject is structurally mandatory
      void store.load();
      // @ts-expect-error subject and CAS values are structurally mandatory
      void store.compareAndSwap();
      // @ts-expect-error subject is structurally mandatory
      void store.delete();
    };
    expect(subjectRequired).toBeTypeOf("function");
    expect(store.load.length).toBeGreaterThanOrEqual(1);
  });

  it("12. honors device interval, slow_down backoff, pending, and success", async () => {
    const sleeps: number[] = [];
    let polls = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/usercode")) {
        return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device-1", interval: 1, expires_in: 60 });
      }
      if (url.endsWith("/deviceauth/token")) {
        polls += 1;
        if (polls === 1) return Response.json({ error: "authorization_pending" }, { status: 403 });
        if (polls === 2) return new Response(null, { status: 403 });
        if (polls === 3) return Response.json({ error: "slow_down" }, { status: 400 });
        return Response.json({ authorization_code: "code", code_verifier: "verifier" });
      }
      return tokenResponse();
    });
    let clock = 0;
    const session = createAuthSession({
      store: createMemoryStore(),
      fetch: request as unknown as typeof fetch,
      now: () => clock,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    });
    const device = await session.startDeviceLogin(subject);
    await expect(device.wait()).resolves.toMatchObject({ accessToken: "access-new" });
    expect(sleeps).toEqual([1_000, 1_000, 1_000, 6_000]);
    expect(polls).toBe(4);
  });

  it("13. exposes complete, partial, and missing backend rate-limit headers safely", async () => {
    const observed = vi.fn();
    const responses = [
      streamResponse(["data: [DONE]\n\n"], 200, {
        "x-codex-primary-used-percent": "25.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1700003600",
        "x-codex-secondary-used-percent": "4",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": "1700604800",
      }),
      streamResponse(["data: [DONE]\n\n"], 200, {
        "x-codex-primary-used-percent": "not-a-number",
        "x-codex-secondary-used-percent": "9",
      }),
      streamResponse(["data: [DONE]\n\n"]),
    ];
    const client = createClient(fakeSession(), subject, {
      fetch: vi.fn(async () => responses.shift() as Response) as unknown as typeof fetch,
      onRateLimits: observed,
    });

    await client.respond({ model: "gpt-test", input: "one" });
    expect(client.lastRateLimits).toEqual({
      primary: { usedPercent: 25.5, windowMinutes: 300, resetsAt: 1700003600 },
      secondary: { usedPercent: 4, windowMinutes: 10080, resetsAt: 1700604800 },
    });
    await client.respond({ model: "gpt-test", input: "two" });
    expect(client.lastRateLimits).toEqual({ secondary: { usedPercent: 9 } });
    await client.respond({ model: "gpt-test", input: "three" });
    expect(client.lastRateLimits).toEqual({});
    expect(observed).toHaveBeenCalledTimes(3);
  });

  it("14. rejects an empty or blank subject before any credential lookup", async () => {
    const store = {
      load: vi.fn(async () => null),
      compareAndSwap: vi.fn(async () => ({ ok: true, current: null })),
      delete: vi.fn(async () => undefined),
    } satisfies CredentialStore;
    const session = createAuthSession({ store });

    for (const empty of ["", "   "]) {
      await expect(session.getAccessToken(empty)).rejects.toBeInstanceOf(StoreError);
      await expect(session.status(empty)).rejects.toBeInstanceOf(StoreError);
      await expect(session.logout(empty)).rejects.toBeInstanceOf(StoreError);
    }
    // The point is not merely that it throws: no credential row may be read or written for "".
    expect(store.load).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();

    // The store layer guards independently of the session layer.
    await expect(createMemoryStore().load("")).rejects.toBeInstanceOf(StoreError);
    await expect(createMemoryStore().delete("")).rejects.toBeInstanceOf(StoreError);
  });

  it("15. blocks every credential entry point while disabled but still allows logout", async () => {
    const store = {
      load: vi.fn(async () => token()),
      compareAndSwap: vi.fn(async () => ({ ok: true, current: token() })),
      delete: vi.fn(async () => undefined),
    } satisfies CredentialStore;
    const request = vi.fn(async () => tokenResponse());
    const session = createAuthSession({
      store,
      disabled: () => true,
      fetch: request as unknown as typeof fetch,
    });

    await expect(session.getAccessToken(subject)).rejects.toBeInstanceOf(DisabledError);
    await expect(session.getTokenSet(subject)).rejects.toBeInstanceOf(DisabledError);
    await expect(session.refreshAccessToken(subject)).rejects.toBeInstanceOf(DisabledError);
    await expect(session.status(subject)).rejects.toBeInstanceOf(DisabledError);
    await expect(session.startDeviceLogin(subject)).rejects.toBeInstanceOf(DisabledError);
    await expect(
      session.completeLogin(subject, "http://localhost/cb?state=s&code=c", { url: "u", state: "s", verifier: "v", redirectUri: "r" }),
    ).rejects.toBeInstanceOf(DisabledError);

    // The kill switch must stop the store and the network, not just raise afterwards.
    expect(store.load).not.toHaveBeenCalled();
    expect(store.compareAndSwap).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    // Logout stays reachable: trapping credentials with no way to delete them is worse.
    await expect(session.logout(subject)).resolves.toBeUndefined();
    expect(store.delete).toHaveBeenCalledWith(subject);

    // The guard must be conditional, not always-on.
    const enabled = createAuthSession({ store, disabled: () => false, fetch: request as unknown as typeof fetch });
    await expect(enabled.status(subject)).resolves.not.toBeNull();
  });

  it("16. adopts a healthy concurrent rotation instead of quarantining it", async () => {
    const healthy = token({ version: 2, accessToken: "healthy-access", expiresAt: 10_000_000 });
    const store: CredentialStore = {
      async load() { return token({ expiresAt: 1 }); },
      // The quarantine marker always loses to a newer healthy generation.
      async compareAndSwap() { return { ok: false, current: structuredClone(healthy) }; },
      async delete() {},
    };
    const session = createAuthSession({
      store,
      now: () => 10_000,
      fetch: vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch,
    });

    // PROTOCOL §6: a terminal refresh failure must NOT quarantine a healthy CAS winner.
    await expect(session.getAccessToken(subject)).resolves.toBe("healthy-access");
    expect(healthy.quarantinedAt).toBeUndefined();
  });

  it("17. yields a trailing SSE block that arrives without a final blank line", async () => {
    const response = streamResponse([
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hi\"}\n\n",
      "event: truncated\ndata: last",
    ]);
    if (response.body === null) throw new Error("missing fixture body");
    const events = [];
    for await (const event of parseSSE(response.body)) events.push(event);
    expect(events).toEqual([
      { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hi" }, delta: "Hi" },
      { type: "truncated", data: "last" },
    ]);
  });

  it("18. frames one large event split across many small chunks", async () => {
    // Guards the linear-scan invariant: the parser must not depend on chunk boundaries.
    const payload = "x".repeat(20_000);
    const whole = `data: {"type":"big","delta":"${payload}"}\n\n`;
    const parts = [];
    for (let index = 0; index < whole.length; index += 64) parts.push(whole.slice(index, index + 64));
    const response = streamResponse(parts);
    if (response.body === null) throw new Error("missing fixture body");
    const events = [];
    for await (const event of parseSSE(response.body)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]?.delta).toBe(payload);
  });

  it("19. honors an injected clock for an HTTP-date Retry-After", async () => {
    const sleeps: number[] = [];
    const fakeNow = Date.parse("2030-01-01T00:00:00Z");
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response("{}", { status: 429, headers: { "retry-after": "Tue, 01 Jan 2030 00:00:30 GMT" } });
      }
      return tokenResponse();
    });
    const session = createAuthSession({
      store: createMemoryStore({ [subject]: token({ expiresAt: 1 }) }),
      fetch: request as unknown as typeof fetch,
      now: () => fakeNow,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await expect(session.getAccessToken(subject)).resolves.toBe("access-new");
    // 30s per the fake clock, not per the real one.
    expect(sleeps).toEqual([30_000]);
  });
});
