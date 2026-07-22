/** Locks the handler's custody rules: sealed pending logins are subject-bound and single-use. */
import { describe, expect, it } from "vitest";
import { createChatGPTHandler } from "../src/http/index.js";
import { createAuthSession } from "../src/core/lifecycle.js";
import { createMemoryStore } from "../src/core/memory-store.js";
import type { AuthSession } from "../src/core/types.js";

const SECRET = "test-secret-at-least-32-bytes-long-000";
const BASE = "https://app.example/api/chatgpt";

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function authFor(): AuthSession {
  return createAuthSession({ store: createMemoryStore(), fetch: async () => tokenResponse() });
}

function handlerFor(auth: AuthSession, subject: string) {
  return createChatGPTHandler(auth, { secret: SECRET, subject: () => subject });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

async function beginLogin(handler: (request: Request) => Promise<Response>) {
  const response = await handler(new Request(`${BASE}/login`, { method: "POST" }));
  const { url } = await response.json() as { url: string };
  return { state: new URL(url).searchParams.get("state") ?? "", cookie: cookieFrom(response) };
}

describe("http handler", () => {
  it("signs in and reports only safe session metadata", async () => {
    const auth = authFor();
    const handler = handlerFor(auth, "alice");
    const { state, cookie } = await beginLogin(handler);

    const callback = await handler(new Request(`${BASE}/callback?code=abc&state=${state}`, { headers: { cookie } }));
    expect(callback.status).toBe(302);

    const session = await handler(new Request(`${BASE}/session`, { headers: { cookie } }));
    const body = await session.json() as Record<string, unknown>;
    expect(body.status).toBe("connected");
    expect(Object.keys(body)).not.toContain("accessToken");
  });

  it("refuses a pending cookie minted for a different subject", async () => {
    const auth = authFor();
    const { state, cookie } = await beginLogin(handlerFor(auth, "alice"));

    // Bob presents Alice's cookie against his own trusted session.
    const asBob = handlerFor(auth, "bob");
    const stolen = await asBob(new Request(`${BASE}/callback?code=abc&state=${state}`, { headers: { cookie } }));

    expect(stolen.status).toBe(400);
    expect(await auth.status("bob")).toBeNull();
  });

  it("consumes the pending login so a replayed callback fails", async () => {
    const auth = authFor();
    const handler = handlerFor(auth, "alice");
    const { state, cookie } = await beginLogin(handler);
    const request = () => handler(new Request(`${BASE}/callback?code=abc&state=${state}`, { headers: { cookie } }));

    expect((await request()).status).toBe(302);
    // The 302 cleared the cookie; a browser replaying the URL arrives without it.
    const replayed = await handler(new Request(`${BASE}/callback?code=abc&state=${state}`));
    expect(replayed.status).toBe(400);
  });

  it("answers a forged state with 400, not a server error", async () => {
    const handler = handlerFor(authFor(), "alice");
    const { cookie } = await beginLogin(handler);

    const forged = await handler(new Request(`${BASE}/callback?code=abc&state=forged`, { headers: { cookie } }));

    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ error: "state_mismatch" });
  });

  it("omits Secure on plain-http origins so localhost development works", async () => {
    const handler = handlerFor(authFor(), "alice");
    const response = await handler(new Request("http://localhost:3000/api/chatgpt/login", { method: "POST" }));

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
  });

  it("requires either a secret or a pending store", () => {
    expect(() => createChatGPTHandler(authFor(), { subject: () => "alice" })).toThrow(TypeError);
  });
});
