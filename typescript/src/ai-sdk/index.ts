/** Bridges subject-scoped ChatGPT credentials into the Vercel AI SDK's OpenAI Responses provider. */
import { createOpenAI } from "@ai-sdk/openai";
import { parseRateLimitHeaders, withAuthRetry } from "../core/client.js";
import { PROTOCOL, type ProtocolOverrides } from "../core/constants.js";
import { parseSSE } from "../core/sse.js";
import { redact } from "../core/redact.js";
import { TransportError, type AuthSession, type RateLimitSnapshot } from "../core/types.js";

export interface ChatGPTProviderOptions {
  /** Injected transport, primarily for tests. */
  fetch?: typeof fetch;
  /** Correlates every turn of one conversation; defaults to a fresh UUID per provider. */
  sessionId?: string;
  /** Observes the usage headers the backend attaches to each response. */
  onRateLimits?: (snapshot: RateLimitSnapshot) => void;
  protocol?: ProtocolOverrides;
}

/** A model factory shaped like the AI SDK's own providers: `chatgpt("gpt-5.4-mini")`. */
export type ChatGPTProvider = ReturnType<typeof createOpenAI>["responses"];

function baseUrlFor(responsesUrl: string): string {
  return responsesUrl.replace(/\/responses\/?$/u, "");
}

/**
 * Sampling and bookkeeping parameters the subscription backend answers with
 * `400 Unsupported parameter`, each verified against the live endpoint.
 *
 * The SDK emits most of them from ordinary call options, so `temperature: 0.2`
 * or `maxOutputTokens: 500` would otherwise fail the whole request with a bare
 * "Bad Request" naming nothing. They are dropped here so no consumer has to
 * carry a copy of this list. `stream_options` is refused as an unknown
 * parameter rather than an unsupported one, but is equally fatal.
 *
 * Deliberately NOT dropped, because the backend accepts them: `reasoning`,
 * `include`, `prompt_cache_key`, `service_tier`, `tools`, `tool_choice`, and
 * `text` (both `verbosity` and a `json_schema` format, so structured outputs
 * work).
 */
const UNSUPPORTED_PARAMETERS = [
  "frequency_penalty",
  "logit_bias",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "presence_penalty",
  "safety_identifier",
  "seed",
  "stream_options",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

/**
 * Rewrites the SDK's request into the shape the subscription backend accepts.
 * The backend only speaks streaming `store:false`, so non-streaming calls are
 * issued as streams and collapsed back into a single JSON response below.
 */
function subscriptionBody(raw: string): { body: string; streaming: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") return { body: raw, streaming: false };
  const record = parsed as Record<string, unknown>;
  const streaming = record.stream === true;
  const body: Record<string, unknown> = { ...record, stream: true, store: false, parallel_tool_calls: false };
  for (const parameter of UNSUPPORTED_PARAMETERS) delete body[parameter];
  return { body: JSON.stringify(body), streaming };
}

/** Collapses a completed SSE stream into the single response object `doGenerate` expects. */
async function collapse(response: Response): Promise<Response> {
  if (response.body === null) throw new TransportError("Subscription transport returned no response stream.");
  let completed: unknown;
  let failure: unknown;
  const items: unknown[] = [];
  for await (const event of parseSSE(response.body)) {
    if (event.type === "response.output_item.done") {
      const { item } = event.data as { item?: unknown };
      if (item !== undefined) items.push(item);
    }
    if (event.type === "response.completed") completed = event.data;
    if (event.type === "response.failed" || event.type === "error") failure = event.data;
  }
  if (completed === undefined) {
    const detail = failure === undefined ? "" : `: ${redact(JSON.stringify(failure)).slice(0, 1_024)}`;
    throw new TransportError(`Subscription stream ended without a completed response${detail}`);
  }
  const envelope = completed as { response?: unknown };
  const payload = (envelope.response ?? completed) as Record<string, unknown>;
  // The subscription backend closes with `output: []` and leaves the assistant
  // message in the `output_item.done` events it already sent, so a payload taken
  // at face value decodes as a turn that said nothing. The direct API populates
  // `output`, so an already-filled array is left exactly as it arrived.
  const restored =
    Array.isArray(payload.output) && payload.output.length > 0 ? payload : { ...payload, output: items };
  return new Response(JSON.stringify(restored), {
    status: 200,
    headers: { ...Object.fromEntries(response.headers), "content-type": "application/json" },
  });
}

/**
 * Builds an AI SDK provider that authenticates as one subject's ChatGPT subscription.
 *
 * Credentials never leave this closure: the SDK sees only a `fetch` that attaches a
 * freshly refreshed bearer, and retries exactly once through a forced refresh on 401.
 */
export function createChatGPT(
  auth: AuthSession,
  subject: string,
  options: ChatGPTProviderOptions = {},
): ChatGPTProvider {
  const request = options.fetch ?? fetch;
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const responsesUrl = options.protocol?.RESPONSES_URL ?? PROTOCOL.RESPONSES_URL;

  function captureRateLimits(response: Response): void {
    if (options.onRateLimits === undefined) return;
    // Consumer telemetry must never turn a successful model response into a failure.
    try { options.onRateLimits(parseRateLimitHeaders(response.headers)); }
    catch { /* Deliberately isolated from transport success. */ }
  }

  const clientVersion = options.protocol?.CLIENT_VERSION ?? PROTOCOL.CLIENT_VERSION;

  const authFetch: typeof fetch = async (input, init) => {
    const rewritten = typeof init?.body === "string" ? subscriptionBody(init.body) : undefined;
    // The backend rejects /responses without client_version (400 missing query param).
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (!target.searchParams.has("client_version")) target.searchParams.set("client_version", clientVersion);
    input = target.toString();

    const response = await withAuthRetry(auth, subject, async (tokenSet) => {
      try {
        return await request(input, {
          ...init,
          ...(rewritten === undefined ? {} : { body: rewritten.body }),
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            authorization: `Bearer ${tokenSet.accessToken}`,
            ...(tokenSet.accountId === undefined ? {} : { "chatgpt-account-id": tokenSet.accountId }),
            "openai-beta": "responses=experimental",
            originator: "codex_cli_rs",
            session_id: sessionId,
          },
        });
      } catch (error) {
        // Match core/client.ts: a DNS/TLS/reset failure must surface as a typed, redacted
        // TransportError, not a raw TypeError that escapes `instanceof ChatGPTOAuthError`.
        const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
        throw new TransportError(`Subscription request failed: ${message}`);
      }
    });
    captureRateLimits(response);
    if (!response.ok || rewritten === undefined || rewritten.streaming) return response;
    return collapse(response);
  };

  return createOpenAI({
    apiKey: "chatgpt-oauth", // Unused: authFetch replaces the Authorization header on every request.
    baseURL: baseUrlFor(responsesUrl),
    fetch: authFetch,
  }).responses;
}
