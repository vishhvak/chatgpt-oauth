/**
 * Locks the codex realtime handshake: subscribe-before-start ordering, the exact start payload
 * (webrtc + v3 is the only shape a subscription login accepts), and failure routing.
 */
import { describe, expect, it, vi } from "vitest";
import { AppServerError } from "../src/app-server/errors.js";
import { startLiveCall, type RealtimeRpc } from "../src/app-server/realtime.js";

const THREAD = "thread_1";

interface Fake extends RealtimeRpc {
  requests: Array<{ method: string; params?: unknown }>;
  emit(method: string, params: unknown): void;
  listenerCount(): number;
}

function fakeRpc(
  respond: (method: string, params?: unknown) => unknown = () => ({}),
): Fake {
  const listeners = new Set<(notification: { method: string; params?: unknown }) => void>();
  const requests: Fake["requests"] = [];
  return {
    requests,
    async request<T>(method: string, params?: unknown): Promise<T> {
      requests.push({ method, ...(params === undefined ? {} : { params }) });
      if (method === "thread/start") return { thread: { id: THREAD } } as T;
      return respond(method, params) as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(method, params) {
      for (const listener of listeners) listener({ method, params });
    },
    listenerCount: () => listeners.size,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return { offerSdp: "offer-sdp", cwd: "/repo", ...overrides };
}

describe("startLiveCall", () => {
  it("subscribes before thread/realtime/start, so an instant answer cannot be missed", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") {
        // The backend can answer before the request even resolves. The listener must be there.
        expect(rpc.listenerCount()).toBeGreaterThan(0);
        rpc.emit("thread/realtime/sdp", { threadId: THREAD, sdp: "answer-sdp" });
      }
      return {};
    });
    const call = await startLiveCall(rpc, options());
    expect(call.answerSdp).toBe("answer-sdp");
    expect(call.threadId).toBe(THREAD);
  });

  it("sends the only start shape a subscription login accepts: webrtc transport, version v3", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") rpc.emit("thread/realtime/sdp", { threadId: THREAD, sdp: "a" });
      return {};
    });
    await startLiveCall(rpc, options({ voice: "cove", instructions: "be brief" }));

    const start = rpc.requests.find((entry) => entry.method === "thread/realtime/start");
    expect(start?.params).toEqual({
      threadId: THREAD,
      transport: { type: "webrtc", sdp: "offer-sdp" },
      outputModality: "audio",
      version: "v3",
      voice: "cove",
      realtimeStartInstructions: "be brief",
    });
  });

  it("ignores notifications for other threads", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") {
        rpc.emit("thread/realtime/sdp", { threadId: "other", sdp: "wrong" });
        rpc.emit("thread/realtime/sdp", { threadId: THREAD, sdp: "right" });
      }
      return {};
    });
    const call = await startLiveCall(rpc, options());
    expect(call.answerSdp).toBe("right");
  });

  it("rejects with the codex error message when the session is refused", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") {
        rpc.emit("thread/realtime/error", { threadId: THREAD, message: "realtime conversation requires API key auth" });
      }
      return {};
    });
    await expect(startLiveCall(rpc, options())).rejects.toThrow(/requires API key auth/);
  });

  it("times out rather than hanging when no answer arrives", async () => {
    vi.useFakeTimers();
    try {
      const rpc = fakeRpc();
      const pending = startLiveCall(rpc, options({ answerTimeoutMs: 1_000 }));
      const guarded = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await guarded).toBeInstanceOf(AppServerError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes transcripts by role and stops listening after close", async () => {
    const onTranscript = vi.fn();
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") rpc.emit("thread/realtime/sdp", { threadId: THREAD, sdp: "a" });
      return {};
    });
    const call = await startLiveCall(rpc, options({ onTranscript }));

    rpc.emit("thread/realtime/transcript/delta", { threadId: THREAD, delta: "hel", role: "user" });
    rpc.emit("thread/realtime/transcript/delta", { threadId: THREAD, delta: "lo", role: "assistant" });
    expect(onTranscript).toHaveBeenNthCalledWith(1, "hel", "user");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "lo", "assistant");

    await call.close();
    expect(rpc.listenerCount()).toBe(0);
    expect(rpc.requests.at(-1)?.method).toBe("thread/realtime/stop");

    rpc.emit("thread/realtime/transcript/delta", { threadId: THREAD, delta: "late", role: "user" });
    expect(onTranscript).toHaveBeenCalledTimes(2);
  });

  it("speaks and appends against the call's thread", async () => {
    const rpc = fakeRpc((method) => {
      if (method === "thread/realtime/start") rpc.emit("thread/realtime/sdp", { threadId: THREAD, sdp: "a" });
      return {};
    });
    const call = await startLiveCall(rpc, options());
    await call.say("hello there");
    await call.append("context note");
    expect(rpc.requests.at(-2)).toEqual({ method: "thread/realtime/appendSpeech", params: { threadId: THREAD, text: "hello there" } });
    expect(rpc.requests.at(-1)).toEqual({ method: "thread/realtime/appendText", params: { threadId: THREAD, text: "context note" } });
  });
});
