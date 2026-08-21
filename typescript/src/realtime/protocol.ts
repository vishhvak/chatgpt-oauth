/**
 * The gpt-live wire protocol: full-duplex voice over the subscription backend.
 *
 * This is a different protocol from the turn-based realtime session, not a variation on it. The
 * model listens and speaks at once and decides many times per second whether to talk, wait, or
 * delegate. There is no `response.create` and no `conversation.item.create`, because there is no
 * request/response cycle to attach them to.
 *
 * Every constant here was read off a live account. Nothing is inferred from documentation.
 */

/**
 * All three of these must be right together or the call is refused:
 *
 * 1. both query parameters (dropping `architecture` returns 400)
 * 2. the `openai-alpha` header below
 * 3. a session body with no `type` field (see {@link liveSessionBody})
 *
 * Sending `{"type": "quicksilver"}` instead returns `403 Voice session access denied` on accounts
 * where the shape below succeeds, so that 403 reads like an entitlement problem and is not one.
 */
export const LIVE_PROTOCOL = {
  CALLS_URL: "https://chatgpt.com/backend-api/codex/realtime/calls",
  QUERY: "intent=quicksilver&architecture=avas",
  /** Selects the frameless-bidi wire. Upstream calls this wire "v3"; the header value says v2. */
  ALPHA: "quicksilver=v2",
  MODEL: "gpt-live-1-boulder-alpha",
} as const;

export type LiveProtocolOverrides = Partial<Record<keyof typeof LIVE_PROTOCOL, string>>;

/** The nine remastered voices, plus the older set the backend still accepts. */
export const LIVE_VOICES = [
  "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember",
  "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
] as const;

export type LiveVoice = (typeof LIVE_VOICES)[number];

export interface LiveSessionConfig {
  instructions?: string;
  voice?: LiveVoice;
  model?: string;
  /**
   * Whether the backend inserts a short acknowledgement while a delegation runs. Omit to keep
   * the server default.
   */
  delegationAckFiller?: boolean;
}

/**
 * Builds the session body.
 *
 * Note what is absent: no `type`, and no `audio.input` block. The frameless shape takes neither,
 * and adding either one changes how the request is routed. `delegation.type: "client"` is what
 * makes the caller the background model rather than letting the backend choose one.
 */
export function liveSessionBody(config: LiveSessionConfig): Record<string, unknown> {
  const session: Record<string, unknown> = {
    model: config.model ?? LIVE_PROTOCOL.MODEL,
    audio: { output: { voice: config.voice ?? "cove" } },
    delegation:
      config.delegationAckFiller === undefined
        ? { type: "client" }
        : { type: "client", ack_filler: config.delegationAckFiller },
  };
  if (config.instructions !== undefined) session.instructions = config.instructions;
  return session;
}

/** Text payloads are always this shape, in both directions. */
export interface LiveTextContent {
  type: "input_text";
  text: string;
}

export function liveText(value: string): LiveTextContent[] {
  return [{ type: "input_text", text: value }];
}

/**
 * Where appended text lands.
 *
 * `commentary` is voiced as progress while work is still running, which is how the model keeps
 * talking through a delegation. `speakable` is voiced as the answer. `analysis` is context the
 * model may use but will not say aloud.
 */
export type LiveChannel = "analysis" | "commentary" | "speakable";

/**
 * The complete set of client events. The server rejects anything else by name, listing these five
 * back in the error, so this union is exhaustive rather than a best guess.
 */
export type LiveClientEvent =
  | { type: "session.update"; session: Record<string, unknown> }
  | { type: "session.context.append"; channel?: LiveChannel; content: LiveTextContent[] }
  | {
      type: "delegation.context.append";
      delegation_item_id: string;
      channel?: LiveChannel;
      content: LiveTextContent[];
    }
  | { type: "delegation.function_call_output.create"; delegation_item_id: string; output: string }
  | { type: "session.close" };

export interface LiveTranscriptItem {
  id: string;
  type: "input_transcript" | "output_transcript";
  text: string;
}

/**
 * Turns overlap: an assistant turn can open before the user turn that prompted it has closed.
 * That is the observable signature of full duplex, and it is why `start_ms`/`end_ms` matter.
 */
export interface LiveTurn {
  id: string;
  role: "user" | "assistant";
  start_ms: number;
  end_ms: number;
  transcript: string;
}

/** A unit of work the model handed to the client because it needs search or deeper reasoning. */
export interface LiveDelegationItem {
  id: string;
  type: "delegation";
  target: "client";
  content: LiveTextContent[];
}

/** Server events. Transcript text lives at `item.text`, never at `delta`. */
export type LiveServerEvent =
  | { type: "session.started"; session: { id: string; model: string; expires_at: number } }
  | { type: "session.updated"; session: Record<string, unknown> }
  | { type: "session.context.appended" }
  | { type: "input_transcript.added"; start_ms: number; end_ms: number; item: LiveTranscriptItem }
  | { type: "output_transcript.added"; start_ms: number; end_ms: number; item: LiveTranscriptItem }
  | { type: "turn.created"; turn: LiveTurn }
  | { type: "turn.delta"; turn: LiveTurn }
  | { type: "turn.done"; turn: LiveTurn }
  | { type: "delegation.created"; offset_ms: number; item: LiveDelegationItem }
  | { type: "error"; error: { type?: string; code?: string; message: string } }
  | { type: string; [key: string]: unknown };

/** Flattens a delegation's content parts into the prompt to run. */
export function delegationPrompt(item: LiveDelegationItem): string {
  return item.content.map((part) => part.text).join(" ").trim();
}

export function callsUrl(overrides?: LiveProtocolOverrides): string {
  const base = overrides?.CALLS_URL ?? LIVE_PROTOCOL.CALLS_URL;
  return `${base}${base.includes("?") ? "&" : "?"}${overrides?.QUERY ?? LIVE_PROTOCOL.QUERY}`;
}
