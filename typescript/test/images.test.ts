/** Locks the image wire shape and the failure modes that are easy to misread as credential bugs. */
import { describe, expect, it, vi } from "vitest";
import { createAuthSession } from "../src/core/lifecycle.js";
import { createMemoryStore } from "../src/core/memory-store.js";
import {
  AuthError,
  RateLimitError,
  TransportError,
  type CredentialStore,
  type TokenSet,
} from "../src/core/types.js";
import {
  decodeBase64,
  editImage,
  encodeBase64,
  generateImage,
  imageReference,
  IMAGE_PROTOCOL,
} from "../src/images/index.js";

const HOUR = 3_600_000;
/** One transparent pixel; small enough to assert on byte-for-byte. */
const PIXEL_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

function imageResponse(body: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      created: 1_787_270_572,
      data: [{ b64_json: PIXEL_B64 }],
      background: "opaque",
      quality: "medium",
      size: "1254x1254",
      output_format: "png",
      usage: { input_tokens: 27, output_tokens: 915, total_tokens: 942 },
      ...body,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function session(): Promise<ReturnType<typeof createAuthSession>> {
  return createAuthSession({ store: await seeded() });
}

describe("image protocol", () => {
  it("targets the codex backend, not the API-key images endpoint", () => {
    expect(IMAGE_PROTOCOL.GENERATIONS_URL).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
    expect(IMAGE_PROTOCOL.EDITS_URL).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(IMAGE_PROTOCOL.MODEL).toBe("gpt-image-2");
  });

  it("round-trips base64 in both directions", () => {
    const bytes = decodeBase64(PIXEL_B64);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // "P" of the PNG magic
    expect(encodeBase64(bytes)).toBe(PIXEL_B64);
  });

  it("wraps reference bytes as a data URL, since the endpoint rejects raw bytes", () => {
    expect(imageReference(decodeBase64(PIXEL_B64)).image_url).toBe(
      `data:image/png;base64,${PIXEL_B64}`,
    );
    expect(imageReference(PIXEL_B64, "image/webp").image_url).toBe(
      `data:image/webp;base64,${PIXEL_B64}`,
    );
  });
});

describe("generateImage", () => {
  it("sends the documented body and auth headers", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    await generateImage(await session(), "alice", "a red circle", {
      fetch: request as unknown as typeof fetch,
      n: 2,
      quality: "high",
      background: "transparent",
      size: "1024x1024",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(IMAGE_PROTOCOL.GENERATIONS_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-token-value");
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(headers["x-codex-image-turn-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.originator).toBe("codex_cli_rs");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a red circle",
      model: "gpt-image-2",
      n: 2,
      quality: "high",
      background: "transparent",
      size: "1024x1024",
    });
  });

  it("omits optional fields rather than sending nulls", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    await generateImage(await session(), "alice", "a red circle", {
      fetch: request as unknown as typeof fetch,
    });
    const body = JSON.parse(request.mock.calls[0]![1].body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "prompt"]);
  });

  it("decodes images and surfaces what the backend actually produced", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    const result = await generateImage(await session(), "alice", "a red circle", {
      fetch: request as unknown as typeof fetch,
      size: "1024x1024",
      quality: "low",
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.bytes[0]).toBe(0x89);
    expect(result.images[0]?.base64).toBe(PIXEL_B64);
    // Requested low/1024x1024; the backend answered otherwise and the result must say so.
    expect(result.size).toBe("1254x1254");
    expect(result.quality).toBe("medium");
    expect(result.outputFormat).toBe("png");
    expect(result.usage?.total_tokens).toBe(942);
  });

  it("reports a 403 as a plan problem, not a credential problem", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => new Response("denied", { status: 403 }));
    await expect(
      generateImage(await session(), "alice", "x", {
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow(AuthError);
    await expect(
      generateImage(await session(), "alice", "x", {
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/paid ChatGPT plan/);
  });

  it("raises RateLimitError on 429", async () => {
    const request = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(
      generateImage(await session(), "alice", "x", {
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow(RateLimitError);
  });

  it("wraps transport failures instead of leaking fetch errors", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error("socket hang up");
    });
    await expect(
      generateImage(await session(), "alice", "x", {
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow(TransportError);
  });

  it("passes an abort signal through, since generations run for tens of seconds", async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    await generateImage(await session(), "alice", "x", {
      fetch: request as unknown as typeof fetch,
      signal: controller.signal,
    });
    const init = request.mock.calls[0]![1];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("editImage", () => {
  it("posts references to the edits endpoint alongside the prompt", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    await editImage(
      await session(),
      "alice",
      [imageReference(PIXEL_B64), imageReference(PIXEL_B64, "image/jpeg")],
      "add a hat",
      { fetch: request as unknown as typeof fetch },
    );

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(IMAGE_PROTOCOL.EDITS_URL);
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toBe("add a hat");
    expect(body.images).toHaveLength(2);
    expect(body.images[0].image_url).toBe(`data:image/png;base64,${PIXEL_B64}`);
    expect(body.images[1].image_url).toBe(`data:image/jpeg;base64,${PIXEL_B64}`);
  });

  it("refuses an empty reference list rather than letting the backend 400", async () => {
    const request = vi.fn(async (_url: string, _init: RequestInit) => imageResponse());
    await expect(
      editImage(await session(), "alice", [], "add a hat", {
        fetch: request as unknown as typeof fetch,
      }),
    ).rejects.toThrow(TransportError);
    expect(request).not.toHaveBeenCalled();
  });
});
