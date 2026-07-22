/** Bridges subject-scoped ChatGPT credentials into the Vercel AI SDK's OpenAI Responses provider. */
import { createOpenAI } from "@ai-sdk/openai";
import { parseRateLimitHeaders } from "../core/client.js";
import { PROTOCOL, type ProtocolOverrides } from "../core/constants.js";
import { parseSSE } from "../core/sse.js";
import { redact } from "../core/redact.js";
import { AuthError, TransportError, type AuthSession, type RateLimitSnapshot } from "../core/types.js";

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
 * Rewrites the SDK's request into the shape the subscription backend accepts.
 * The backend only speaks streaming `store:false`, so non-streaming calls are
 * issued as streams and collapsed back into a single JSON response below.
 */
function subscriptionBody(raw: string): { body: string; streaming: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") return { body: raw, streaming: false };
  const record = parsed as Record<string, unknown>;
  const streaming = record.stream === true;
  return {
    body: JSON.stringify({ ...record, stream: true, store: false, parallel_tool_calls: false }),
    streaming,
  };
}

/** Collapses a completed SSE stream into the single response object `doGenerate` expects. */
async function collapse(response: Response): Promise<Response> {
  if (response.body === null) throw new TransportError("Subscription transport returned no response stream.");
  let completed: unknown;
  let failure: unknown;
  for await (const event of parseSSE(response.body)) {
    if (event.type === "response.completed") completed = event.data;
    if (event.type === "response.failed" || event.type === "error") failure = event.data;
  }
  if (completed === undefined) {
    const detail = failure === undefined ? "" : `: ${redact(JSON.stringify(failure)).slice(0, 1_024)}`;
    throw new TransportError(`Subscription stream ended without a completed response${detail}`);
  }
  const envelope = completed as { response?: unknown };
  const payload = envelope.response ?? completed;
  return new Response(JSON.stringify(payload), {
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

    async function send(retried: boolean): Promise<Response> {
      const accessToken = retried
        ? await auth.refreshAccessToken(subject)
        : await auth.getAccessToken(subject);
      const status = await auth.status(subject);
      const response = await request(input, {
        ...init,
        ...(rewritten === undefined ? {} : { body: rewritten.body }),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          authorization: `Bearer ${accessToken}`,
          ...(status?.accountId === undefined ? {} : { "chatgpt-account-id": status.accountId }),
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          session_id: sessionId,
        },
      });
      if (response.status !== 401) return response;
      if (retried) throw new AuthError("Authentication was rejected after one refresh retry.");
      return send(true);
    }

    const response = await send(false);
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
