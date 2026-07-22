/** Locks the two behaviors the AI SDK bridge exists for: forced streaming and one-shot collapse. */
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createChatGPT } from "../src/ai-sdk/index.js";
import { createAuthSession } from "../src/core/lifecycle.js";
import { createMemoryStore } from "../src/core/memory-store.js";
import type { CredentialStore, TokenSet } from "../src/core/types.js";

const HOUR = 3_600_000;

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    expiresAt: Date.now() + HOUR,
    accountId: "acct_123",
    version: 1,
    ...overrides,
  };
}

async function seeded(): Promise<CredentialStore> {
  const store = createMemoryStore();
  await store.compareAndSwap("alice", 0, tokenSet());
  return store;
}

function sse(...events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const COMPLETED = {
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "gpt-5.4-mini",
    status: "completed",
    output: [
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
};

/** The SDK's stream parser only emits text once the full item/part lifecycle has opened. */
function textStreamEvents(deltas: string[]): unknown[] {
  return [
    { type: "response.created", response: { ...COMPLETED.response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    ...deltas.map((delta) => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta })),
    { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: deltas.join(""), annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: deltas.join(""), annotations: [] }] } },
    COMPLETED,
  ];
}

describe("ai-sdk bridge", () => {
  it("forces stream/store and collapses SSE for non-streaming generateText", async () => {
    const requests: Record<string, unknown>[] = [];
    const auth = createAuthSession({ store: await seeded() });
    const chatgpt = createChatGPT(auth, "alice", {
      fetch: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse({ type: "response.output_text.delta", delta: "hi" }, COMPLETED);
      },
    });

    const result = await generateText({ model: chatgpt("gpt-5.4-mini"), prompt: "hello" });

    expect(result.text).toBe("hi");
    // The SDK asked for a one-shot call; the backend only speaks streaming store:false.
    expect(requests[0]).toMatchObject({ stream: true, store: false, parallel_tool_calls: false });
  });

  it("passes a real stream through untouched", async () => {
    const auth = createAuthSession({ store: await seeded() });
    const chatgpt = createChatGPT(auth, "alice", {
      fetch: async () => sse(...textStreamEvents(["a", "b"])),
    });

    let text = "";
    for await (const delta of streamText({ model: chatgpt("gpt-5.4-mini"), prompt: "hello" }).textStream) text += delta;
    expect(text).toBe("ab");
  });

  it("attaches the bearer, account id, and client_version without leaking them into the SDK config", async () => {
    let seen: Headers | undefined;
    let url: string | undefined;
    const auth = createAuthSession({ store: await seeded() });
    const chatgpt = createChatGPT(auth, "alice", {
      fetch: async (input, init) => {
        seen = new Headers(init?.headers);
        url = String(input);
        return sse(COMPLETED);
      },
    });

    await generateText({ model: chatgpt("gpt-5.4-mini"), prompt: "hello" });

    expect(seen?.get("authorization")).toBe("Bearer access-token-value");
    expect(seen?.get("chatgpt-account-id")).toBe("acct_123");
    expect(seen?.get("originator")).toBe("codex_cli_rs");
    // The backend 400s without this query param; the bridge must supply it.
    expect(url).toContain("client_version=");
  });

  it("retries once through a forced refresh on 401", async () => {
    const store = createMemoryStore();
    await store.compareAndSwap("alice", 0, tokenSet({ expiresAt: Date.now() + HOUR }));
    let calls = 0;
    const auth = createAuthSession({
      store,
      fetch: async (input) => {
        // The refresh endpoint is the only non-responses call in this test.
        if (String(input).includes("/oauth/token")) {
          return new Response(JSON.stringify({ access_token: "rotated", refresh_token: "r2", expires_in: 3600 }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected auth fetch: ${String(input)}`);
      },
    });
    const chatgpt = createChatGPT(auth, "alice", {
      fetch: async (_input, init) => {
        calls += 1;
        if (calls === 1) return new Response("", { status: 401 });
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated");
        return sse(COMPLETED);
      },
    });

    await generateText({ model: chatgpt("gpt-5.4-mini"), prompt: "hello" });
    expect(calls).toBe(2);
  });
});
