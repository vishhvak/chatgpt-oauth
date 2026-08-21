/**
 * Opens a gpt-live call and drives its event loop.
 *
 * Split in two on purpose, because the two halves have different homes:
 *
 * - {@link createLiveCall} is the signalling half. Plain HTTP, runs wherever the credentials live,
 *   which for a web app means the server so the refresh token never reaches the browser.
 * - {@link attachLiveSession} is the session half. Pure event plumbing over anything that looks
 *   like a data channel, so it works with a browser `RTCDataChannel`, a Node WebRTC binding, or a
 *   fake in a test.
 *
 * The media itself is never touched here. Peer connections stay with the caller, because the only
 * portable thing about WebRTC is the SDP.
 */
import { withAuthRetry } from "../core/client.js";
import { redactedResponseSnippet } from "../core/redact.js";
import { AuthError, RateLimitError, TransportError, type AuthSession } from "../core/types.js";
import { retryAfter } from "../core/oauth.js";
import {
  callsUrl,
  delegationPrompt,
  liveSessionBody,
  liveText,
  LIVE_PROTOCOL,
  type LiveChannel,
  type LiveClientEvent,
  type LiveDelegationItem,
  type LiveProtocolOverrides,
  type LiveServerEvent,
  type LiveSessionConfig,
  type LiveTurn,
} from "./protocol.js";

export interface LiveCallOptions extends LiveSessionConfig {
  fetch?: typeof fetch;
  protocol?: LiveProtocolOverrides;
}

export interface LiveCallResult {
  /** The answer SDP. Feed it to `setRemoteDescription`. */
  answerSdp: string;
  /** Parsed out of the `Location` header; identifies this call to any sideband connection. */
  callId: string | null;
}

function callId(location: string | null): string | null {
  if (location === null) return null;
  const [path] = location.split("?");
  const segments = (path ?? "").split("/").filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  return last === undefined || last === "" ? null : last;
}

/**
 * Exchanges an SDP offer for an answer.
 *
 * Mirrors the 401 handling of the Responses transport exactly: one forced refresh and one retry,
 * then a typed error. A voice call that silently reconnects on a stale token would be worse than
 * one that fails loudly, because the user is mid-sentence.
 */
export async function createLiveCall(
  auth: AuthSession,
  subject: string,
  offerSdp: string,
  options: LiveCallOptions = {},
): Promise<LiveCallResult> {
  const request = options.fetch ?? fetch;
  const endpoint = callsUrl(options.protocol);
  const body = JSON.stringify({ sdp: offerSdp, session: liveSessionBody(options) });

  const response = await withAuthRetry(auth, subject, async (tokenSet) => {
    try {
      return await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenSet.accessToken}`,
          ...(tokenSet.accountId === undefined ? {} : { "chatgpt-account-id": tokenSet.accountId }),
          "openai-alpha": options.protocol?.ALPHA ?? LIVE_PROTOCOL.ALPHA,
          originator: "codex_cli_rs",
          "content-type": "application/json",
        },
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransportError(`Realtime call failed: ${message}`);
    }
  });

  if (response.status === 429) throw new RateLimitError(retryAfter(response));
  if (response.status === 401 || response.status === 403) {
    // A 403 here is usually the wrong session shape, not a credential problem. Say so, because
    // the backend's own message ("Voice session access denied") points the reader at the account.
    throw new AuthError(
      `Realtime call rejected (${response.status}). If this is 403, check the session shape: ` +
        "gpt-live requires no `type` field and `delegation.type: \"client\"`.",
    );
  }
  if (!response.ok) {
    throw new TransportError(
      `Realtime call failed (${response.status}): ${await redactedResponseSnippet(response)}`,
    );
  }

  return { answerSdp: await response.text(), callId: callId(response.headers.get("location")) };
}

/** The minimum a transport must provide. `RTCDataChannel` satisfies this structurally. */
export interface LiveChannelLike {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  readyState?: string;
}

export interface LiveSessionHandlers {
  /**
   * Answers one delegated task. Return the text to speak.
   *
   * This is the same role `onToolCall` plays in the AI SDK's realtime hook, and it is where the
   * frontier model belongs: run the prompt through `createClient` or an AI SDK provider and return
   * the result. Throwing is safe; the model is told the lookup failed so it can say so.
   */
  onDelegate?: (prompt: string, item: LiveDelegationItem) => Promise<string> | string;
  /** Fires when a turn opens, updates, or closes. Turns from both roles overlap. */
  onTurn?: (turn: LiveTurn, phase: "created" | "delta" | "done") => void;
  /** Incremental transcript text, already unwrapped from `item.text`. */
  onTranscript?: (text: string, role: "user" | "assistant") => void;
  onSessionStarted?: (sessionId: string, model: string) => void;
  onError?: (error: { code?: string; message: string }) => void;
  /** Every event, including ones this version does not model. */
  onEvent?: (event: LiveServerEvent) => void;
  /**
   * How long a delegation may run before the model is nudged to fill the silence. Set to `null`
   * to never nudge. Defaults to 2500ms.
   */
  commentaryAfterMs?: number | null;
}

export interface LiveSession {
  /** Appends text the model will treat as conversation context. */
  append(text: string, channel?: LiveChannel): void;
  /** Sends a raw client event, for anything this wrapper does not cover. */
  send(event: LiveClientEvent): void;
  /** Asks the backend to end the session. Does not close the peer connection. */
  close(): void;
  /** Delegations currently in flight. */
  readonly pending: ReadonlySet<string>;
}

const DEFAULT_COMMENTARY_AFTER_MS = 2_500;

/**
 * Wires a data channel to handlers, including the full delegation round trip.
 *
 * The delegation loop is the reason this is worth having in the library rather than in each app:
 * getting it wrong means the call goes silent for however long the background model takes, which
 * is exactly the failure the architecture exists to avoid.
 */
export function attachLiveSession(
  channel: LiveChannelLike,
  handlers: LiveSessionHandlers = {},
): LiveSession {
  const pending = new Set<string>();
  const nudgeAfter = handlers.commentaryAfterMs === undefined
    ? DEFAULT_COMMENTARY_AFTER_MS
    : handlers.commentaryAfterMs;

  function send(event: LiveClientEvent): void {
    if (channel.readyState !== undefined && channel.readyState !== "open") return;
    channel.send(JSON.stringify(event));
  }

  async function runDelegation(item: LiveDelegationItem): Promise<void> {
    if (handlers.onDelegate === undefined) return;
    pending.add(item.id);

    let settled = false;
    const nudge =
      nudgeAfter === null
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            send({
              type: "delegation.context.append",
              delegation_item_id: item.id,
              channel: "commentary",
              content: liveText("Still working on that, one moment."),
            });
          }, nudgeAfter);

    try {
      const answer = await handlers.onDelegate(delegationPrompt(item), item);
      settled = true;
      if (nudge !== undefined) clearTimeout(nudge);
      const spoken = answer.trim();
      send({
        type: "delegation.context.append",
        delegation_item_id: item.id,
        channel: "speakable",
        content: liveText(spoken === "" ? "I could not find that." : spoken),
      });
    } catch (error) {
      settled = true;
      if (nudge !== undefined) clearTimeout(nudge);
      // Tell the model the work failed. Silence would leave it waiting mid-conversation.
      send({
        type: "delegation.context.append",
        delegation_item_id: item.id,
        channel: "speakable",
        content: liveText("That lookup failed. Say so briefly and carry on."),
      });
      handlers.onError?.({
        code: "delegation_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pending.delete(item.id);
    }
  }

  channel.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let parsed: LiveServerEvent;
    try {
      parsed = JSON.parse(event.data) as LiveServerEvent;
    } catch {
      return; // Unparsable frames are forward-compatibility noise, not failures.
    }
    handlers.onEvent?.(parsed);

    switch (parsed.type) {
      case "session.started": {
        const session = (parsed as Extract<LiveServerEvent, { type: "session.started" }>).session;
        handlers.onSessionStarted?.(session.id, session.model);
        break;
      }
      case "turn.created":
      case "turn.delta":
      case "turn.done": {
        const { turn } = parsed as { turn: LiveTurn };
        handlers.onTurn?.(turn, parsed.type.slice(5) as "created" | "delta" | "done");
        break;
      }
      case "input_transcript.added":
        handlers.onTranscript?.((parsed as { item: { text: string } }).item.text, "user");
        break;
      case "output_transcript.added":
        handlers.onTranscript?.((parsed as { item: { text: string } }).item.text, "assistant");
        break;
      case "delegation.created":
        void runDelegation((parsed as { item: LiveDelegationItem }).item);
        break;
      case "error":
        handlers.onError?.((parsed as { error: { message: string } }).error);
        break;
      default:
        break;
    }
  });

  return {
    append(text, channelName) {
      send({
        type: "session.context.append",
        ...(channelName === undefined ? {} : { channel: channelName }),
        content: liveText(text),
      });
    },
    send,
    close() {
      send({ type: "session.close" });
    },
    pending,
  };
}
