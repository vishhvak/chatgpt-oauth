/**
 * Full-duplex voice on the codex runtime.
 *
 * The same gpt-live wire as `chatgpt-oauth/realtime`, reached the other way around: instead of
 * this library signalling against the backend directly, the codex app-server owns the realtime
 * session and this module drives it over JSON-RPC. What that buys is the brain: the voice model
 * delegates into the codex thread itself, so the agent answering is the coding agent, with no
 * delegate endpoint to run. What it costs is a spawned codex binary and its experimental flag.
 *
 * Audio never passes through here. The SDP offer comes from the caller's own peer connection
 * (in a browser, `connectLiveCall` from `chatgpt-oauth/realtime/browser` with `negotiate`
 * pointed at this call), the answer goes back to it, and media flows peer to backend directly.
 *
 * Method names and payload shapes were read from the codex source and verified against a live
 * session; all of them are marked experimental upstream and can change with a codex release.
 */
import { AppServerError } from "./errors.js";

/** The slice of the app-server connection this module needs. */
export interface RealtimeRpc {
  request<T>(method: string, params?: unknown): Promise<T>;
  /** Registers a notification listener and returns its remover. */
  subscribe(listener: (notification: { method: string; params?: unknown }) => void): () => void;
}

export interface LiveCallHandlers {
  /** Incremental transcript text for one side of the conversation. */
  onTranscript?: (delta: string, role: "user" | "assistant") => void;
  /** A completed utterance, after its deltas. */
  onTranscriptDone?: (text: string, role: "user" | "assistant") => void;
  onError?: (error: { message: string }) => void;
  /** The realtime transport closed; the peer connection is on its own from here. */
  onClosed?: () => void;
}

export interface AppServerLiveCallOptions extends LiveCallHandlers {
  /** SDP offer from the caller's peer connection, ICE candidates gathered. */
  offerSdp: string;
  /**
   * Working directory for the codex thread that backs the call. This is the repo the voice
   * conversation can ask about, so it is required rather than defaulted to something arbitrary.
   */
  cwd: string;
  voice?: string;
  /** Developer instructions handed to the codex model when the session starts. */
  instructions?: string;
  /** How long to wait for the backend's answer SDP. Defaults to 20s, matching codex's own UI. */
  answerTimeoutMs?: number;
}

export interface AppServerLiveCall {
  /** Feed to `setRemoteDescription` on the offering peer connection. */
  answerSdp: string;
  /** The codex thread answering the call; usable with the text surface too. */
  threadId: string;
  /** Speaks exact text in the session voice. */
  say(text: string): Promise<void>;
  /** Adds a conversation item without forcing speech. */
  append(text: string): Promise<void>;
  /** Ends the realtime session. The caller closes its own peer connection. */
  close(): Promise<void>;
}

const DEFAULT_ANSWER_TIMEOUT_MS = 20_000;

function field(params: unknown, name: string): unknown {
  return params !== null && typeof params === "object"
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

function transcriptRole(value: unknown): "user" | "assistant" {
  return value === "user" ? "user" : "assistant";
}

/**
 * Starts a voice call on an app-server connection and resolves once the answer SDP arrives.
 *
 * Listeners are attached before `thread/realtime/start` is sent, because the answer arrives as a
 * notification and nothing replays it: subscribing after the request is a race that loses.
 */
export async function startLiveCall(
  rpc: RealtimeRpc,
  options: AppServerLiveCallOptions,
): Promise<AppServerLiveCall> {
  const started = await rpc.request<{ thread?: { id?: unknown } }>("thread/start", {
    cwd: options.cwd,
  });
  const threadId = started.thread?.id;
  if (typeof threadId !== "string") {
    throw new AppServerError("Codex thread/start returned no thread id.");
  }

  let closed = false;
  let settled = false;
  let unsubscribe: () => void = () => undefined;
  const answer = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppServerError("Timed out waiting for the realtime answer SDP."));
    }, options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS);

    unsubscribe = rpc.subscribe((notification) => {
      if (field(notification.params, "threadId") !== threadId) return;
      switch (notification.method) {
        case "thread/realtime/sdp": {
          const sdp = field(notification.params, "sdp");
          if (settled || typeof sdp !== "string") return;
          settled = true;
          clearTimeout(timer);
          resolve(sdp);
          return;
        }
        case "thread/realtime/transcript/delta": {
          const delta = field(notification.params, "delta");
          if (typeof delta !== "string") return;
          options.onTranscript?.(delta, transcriptRole(field(notification.params, "role")));
          return;
        }
        case "thread/realtime/transcript/done": {
          const text = field(notification.params, "text");
          if (typeof text !== "string") return;
          options.onTranscriptDone?.(text, transcriptRole(field(notification.params, "role")));
          return;
        }
        case "thread/realtime/error": {
          const message = field(notification.params, "message");
          const failure = new AppServerError(
            `Codex realtime error: ${typeof message === "string" ? message : "unknown"}`,
          );
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(failure);
          }
          options.onError?.({ message: failure.message });
          return;
        }
        case "thread/realtime/closed": {
          closed = true;
          options.onClosed?.();
          return;
        }
        default:
          return;
      }
    });
  });

  try {
    // The websocket transport refuses subscription auth and v2 is refused on WebRTC, so the only
    // shape that works on a plain ChatGPT login is exactly this one.
    await rpc.request("thread/realtime/start", {
      threadId,
      transport: { type: "webrtc", sdp: options.offerSdp },
      outputModality: "audio",
      version: "v3",
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      ...(options.instructions === undefined
        ? {}
        : { realtimeStartInstructions: options.instructions }),
    });
    const answerSdp = await answer;

    return {
      answerSdp,
      threadId,
      async say(text) {
        await rpc.request("thread/realtime/appendSpeech", { threadId, text });
      },
      async append(text) {
        await rpc.request("thread/realtime/appendText", { threadId, text });
      },
      async close() {
        unsubscribe();
        if (closed) return;
        closed = true;
        await rpc.request("thread/realtime/stop", { threadId }).catch(() => {
          // The session may already be gone; closing must not throw on a dead transport.
        });
      },
    };
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
