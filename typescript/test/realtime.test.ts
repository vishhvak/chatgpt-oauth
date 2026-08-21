/** Locks the gpt-live wire shape and the delegation round trip, the two things apps get wrong. */
import { describe, expect, it, vi } from "vitest";
import { createAuthSession } from "../src/core/lifecycle.js";
import { createMemoryStore } from "../src/core/memory-store.js";
import { AuthError, TransportError, type CredentialStore, type TokenSet } from "../src/core/types.js";
import {
  attachLiveSession,
  callsUrl,
  createLiveCall,
  liveSessionBody,
  LIVE_PROTOCOL,
  type LiveChannelLike,
  type LiveServerEvent,
} from "../src/realtime/index.js";

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

function answer(status = 201, location = "/v1/realtime/calls/rtc_u0_ABC"): Response {
  return new Response("v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", {
    status,
    headers: { location },
  });
}

/** Stands in for an RTCDataChannel; records what the session sends. */
function fakeChannel(): LiveChannelLike & { sent: unknown[]; emit: (event: unknown) => void } {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  return {
    sent: [],
    readyState: "open",
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    emit(event: unknown) {
      const data = typeof event === "string" ? event : JSON.stringify(event);
      for (const listener of listeners) listener({ data });
    },
  };
}

function delegationEvent(id = "item_1", text = "look up the population of Tokyo"): LiveServerEvent {
  return {
    type: "delegation.created",
    offset_ms: 6_200,
    item: { id, type: "delegation", target: "client", content: [{ type: "input_text", text }] },
  };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("gpt-live wire shape", () => {
  it("1. omits `type` and `audio.input`, which is what separates it from the turn-based session", () => {
    const body = liveSessionBody({ instructions: "be brief", voice: "marin" });
    expect(body).not.toHaveProperty("type");
    expect(body).not.toHaveProperty("audio.input");
    expect(body).toMatchObject({
      model: LIVE_PROTOCOL.MODEL,
      instructions: "be brief",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
    });
  });

  it("2. always carries both query params; either alone is rejected upstream", () => {
    const url = callsUrl();
    expect(url).toContain("intent=quicksilver");
    expect(url).toContain("architecture=avas");
  });

  it("3. omits ack_filler unless asked, so the server default survives", () => {
    expect(liveSessionBody({}).delegation).toEqual({ type: "client" });
    expect(liveSessionBody({ delegationAckFiller: false }).delegation).toEqual({
      type: "client",
      ack_filler: false,
    });
  });
});

describe("createLiveCall", () => {
  it("4. sends the alpha header and returns the answer SDP plus the call id", async () => {
    const auth = createAuthSession({ store: await seeded() });
    let captured: RequestInit | undefined;
    const result = await createLiveCall(auth, "alice", "v=offer", {
      fetch: (async (_input, init) => {
        captured = init;
        return answer();
      }) as typeof fetch,
    });

    const headers = captured?.headers as Record<string, string>;
    expect(headers["openai-alpha"]).toBe(LIVE_PROTOCOL.ALPHA);
    expect(headers.authorization).toBe("Bearer access-token-value");
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(JSON.parse(captured?.body as string)).toMatchObject({ sdp: "v=offer" });
    expect(result.answerSdp).toContain("v=0");
    expect(result.callId).toBe("rtc_u0_ABC");
  });

  it("5. explains that a 403 is a session-shape problem, not a credential one", async () => {
    const auth = createAuthSession({ store: await seeded() });
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "Voice session access denied." } }), {
        status: 403,
      })) as typeof fetch;

    await expect(createLiveCall(auth, "alice", "v=offer", { fetch: failing })).rejects.toThrow(
      AuthError,
    );
    await expect(createLiveCall(auth, "alice", "v=offer", { fetch: failing })).rejects.toThrow(
      /session shape/u,
    );
  });

  it("6. surfaces a transport failure as a typed error, never a raw TypeError", async () => {
    const auth = createAuthSession({ store: await seeded() });
    const broken = (async () => {
      throw new TypeError("connection reset");
    }) as typeof fetch;

    await expect(createLiveCall(auth, "alice", "v=offer", { fetch: broken })).rejects.toThrow(
      TransportError,
    );
  });

  /**
   * Redaction is shape-based, not value-based: it scrubs anything that looks like a JWT, a
   * `Bearer` header, or a named token field. Real access tokens are JWTs, so an upstream body that
   * echoes one is covered. An arbitrary opaque string would not be, which is inherent to the
   * approach rather than a gap in it.
   */
  it("7. redacts a token echoed back by the upstream error body", async () => {
    const auth = createAuthSession({ store: await seeded() });
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXZhbHVl";
    const failing = (async () =>
      new Response(`upstream rejected Bearer ${jwt}`, { status: 500 })) as typeof fetch;

    try {
      await createLiveCall(auth, "alice", "v=offer", { fetch: failing });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as Error).message).not.toContain(jwt);
      expect((error as Error).message).toContain("[REDACTED]");
    }
  });
});

describe("delegation round trip", () => {
  it("8. answers a delegation on the speakable channel, keyed to the item id", async () => {
    const channel = fakeChannel();
    attachLiveSession(channel, {
      commentaryAfterMs: null,
      onDelegate: (prompt) => `answered: ${prompt}`,
    });

    channel.emit(delegationEvent("item_42"));
    await flush();

    expect(channel.sent).toEqual([
      {
        type: "delegation.context.append",
        delegation_item_id: "item_42",
        channel: "speakable",
        content: [{ type: "input_text", text: "answered: look up the population of Tokyo" }],
      },
    ]);
  });

  it("9. fills the silence on the commentary channel when the work runs long", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      let release: (value: string) => void = () => {};
      attachLiveSession(channel, {
        commentaryAfterMs: 2_500,
        onDelegate: () => new Promise<string>((resolve) => (release = resolve)),
      });

      channel.emit(delegationEvent());
      await vi.advanceTimersByTimeAsync(2_600);

      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]).toMatchObject({ channel: "commentary" });

      release("Tokyo has about 14 million people.");
      await vi.advanceTimersByTimeAsync(0);

      expect(channel.sent).toHaveLength(2);
      expect(channel.sent[1]).toMatchObject({ channel: "speakable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("10. tells the model when a delegation fails, rather than leaving it waiting", async () => {
    const channel = fakeChannel();
    const errors: { message: string }[] = [];
    attachLiveSession(channel, {
      commentaryAfterMs: null,
      onDelegate: () => {
        throw new Error("upstream 500");
      },
      onError: (error) => errors.push(error),
    });

    channel.emit(delegationEvent());
    await flush();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ channel: "speakable" });
    expect(JSON.stringify(channel.sent[0])).toContain("lookup failed");
    expect(errors[0]?.message).toContain("upstream 500");
  });

  it("11. tracks in-flight delegations so callers can show a thinking state", async () => {
    const channel = fakeChannel();
    let release: (value: string) => void = () => {};
    const session = attachLiveSession(channel, {
      commentaryAfterMs: null,
      onDelegate: () => new Promise<string>((resolve) => (release = resolve)),
    });

    channel.emit(delegationEvent("item_7"));
    await flush();
    expect([...session.pending]).toEqual(["item_7"]);

    release("done");
    await flush();
    expect([...session.pending]).toEqual([]);
  });
});

describe("event mapping", () => {
  it("12. unwraps transcript text from item.text, not delta", () => {
    const channel = fakeChannel();
    const heard: [string, string][] = [];
    attachLiveSession(channel, { onTranscript: (text, role) => heard.push([text, role]) });

    channel.emit({
      type: "input_transcript.added",
      start_ms: 0,
      end_ms: 200,
      item: { id: "i1", type: "input_transcript", text: " hello" },
    });
    channel.emit({
      type: "output_transcript.added",
      start_ms: 200,
      end_ms: 400,
      item: { id: "i2", type: "output_transcript", text: " hi" },
    });

    expect(heard).toEqual([
      [" hello", "user"],
      [" hi", "assistant"],
    ]);
  });

  it("13. reports overlapping turns, the observable signature of full duplex", () => {
    const channel = fakeChannel();
    const phases: string[] = [];
    attachLiveSession(channel, { onTurn: (turn, phase) => phases.push(`${turn.role}:${phase}`) });

    // The assistant opens a turn before the user turn that prompted it has closed.
    channel.emit({
      type: "turn.created",
      turn: { id: "t2", role: "assistant", start_ms: 8_600, end_ms: 8_800, transcript: " Sure." },
    });
    channel.emit({
      type: "turn.done",
      turn: { id: "t1", role: "user", start_ms: 4_000, end_ms: 8_800, transcript: " ..." },
    });

    expect(phases).toEqual(["assistant:created", "user:done"]);
  });

  it("14. ignores unparsable frames instead of throwing", () => {
    const channel = fakeChannel();
    const seen: LiveServerEvent[] = [];
    attachLiveSession(channel, { onEvent: (event) => seen.push(event) });

    expect(() => channel.emit("not json at all")).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("15. forwards unknown event types untouched, so new server events are not lost", () => {
    const channel = fakeChannel();
    const seen: LiveServerEvent[] = [];
    attachLiveSession(channel, { onEvent: (event) => seen.push(event) });

    channel.emit({ type: "turn.speculative", payload: 1 });
    expect(seen).toEqual([{ type: "turn.speculative", payload: 1 }]);
  });

  it("16. sends only the five client events the backend accepts", () => {
    const channel = fakeChannel();
    const session = attachLiveSession(channel);

    session.append("some context");
    session.append("aside", "commentary");
    session.close();

    const types = channel.sent.map((event) => (event as { type: string }).type);
    expect(types).toEqual(["session.context.append", "session.context.append", "session.close"]);
    expect(channel.sent[1]).toMatchObject({ channel: "commentary" });
  });
});
