/** Implements the backend-api SubscriptionAI transport and its single reactive auth retry. */
import { PROTOCOL, type ProtocolOverrides } from "./constants.js";
import { redact, redactedResponseSnippet } from "./redact.js";
import { parseSSE } from "./sse.js";
import {
  AuthError,
  RateLimitError,
  TransportError,
  type AuthSession,
  type RateLimitSnapshot,
  type RateLimitWindow,
  type ResponseEvent,
  type ResponseRequest,
  type ResponseResult,
  type SubscriptionAI,
} from "./types.js";

export interface ClientOptions {
  fetch?: typeof fetch;
  protocol?: ProtocolOverrides;
  sessionId?: string;
  onRateLimits?: (snapshot: RateLimitSnapshot) => void;
}

export type BackendApiClient = SubscriptionAI & { readonly lastRateLimits: RateLimitSnapshot | undefined };

function finiteHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rateLimitWindow(headers: Headers, prefix: "primary" | "secondary"): RateLimitWindow | undefined {
  const usedPercent = finiteHeader(headers, `x-codex-${prefix}-used-percent`);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = finiteHeader(headers, `x-codex-${prefix}-window-minutes`);
  const resetsAt = finiteHeader(headers, `x-codex-${prefix}-reset-at`);
  return {
    usedPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const primary = rateLimitWindow(headers, "primary");
  const secondary = rateLimitWindow(headers, "secondary");
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
  };
}

function rateLimit(response: Response): RateLimitError {
  const raw = response.headers.get("retry-after");
  if (raw === null) return new RateLimitError();
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return new RateLimitError(Math.max(0, seconds * 1_000));
  const date = Date.parse(raw);
  return new RateLimitError(Number.isNaN(date) ? undefined : Math.max(0, date - Date.now()));
}

/** The backend rejects bare-string input ("Input must be a list"); wrap it as one user message. */
function normalizeInput(input: ResponseRequest["input"]): ReadonlyArray<Record<string, unknown>> {
  if (typeof input !== "string") return input;
  return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
}

export function createClient(session: AuthSession, subject: string, options: ClientOptions = {}): BackendApiClient {
  const request = options.fetch ?? fetch;
  const baseEndpoint = options.protocol?.RESPONSES_URL ?? PROTOCOL.RESPONSES_URL;
  const clientVersion = options.protocol?.CLIENT_VERSION ?? PROTOCOL.CLIENT_VERSION;
  // The backend rejects requests without client_version (400 missing query param).
  const endpoint = `${baseEndpoint}${baseEndpoint.includes("?") ? "&" : "?"}client_version=${clientVersion}`;
  const sessionId = options.sessionId ?? crypto.randomUUID();
  let lastRateLimits: RateLimitSnapshot | undefined;

  function captureRateLimits(snapshot: RateLimitSnapshot): void {
    lastRateLimits = snapshot;
    // Consumer telemetry must never turn a successful model response into a failure.
    try { options.onRateLimits?.(snapshot); }
    catch { /* Deliberately isolated from transport success. */ }
  }

  async function send(req: ResponseRequest, retried: boolean): Promise<Response> {
    const accessToken = retried
      ? await session.refreshAccessToken(subject)
      : await session.getAccessToken(subject);
    const status = await session.status(subject);
    let response: Response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(status?.accountId === undefined ? {} : { "chatgpt-account-id": status.accountId }),
          "openai-beta": "responses=experimental",
          originator: "codex_cli_rs",
          "content-type": "application/json",
          session_id: sessionId,
        },
        body: JSON.stringify({
          model: req.model,
          ...(req.instructions === undefined ? {} : { instructions: req.instructions }),
          input: normalizeInput(req.input),
          ...(req.tools === undefined ? {} : { tools: req.tools }),
          ...(req.tool_choice === undefined ? {} : { tool_choice: req.tool_choice }),
          parallel_tool_calls: false,
          store: false,
          stream: true,
          ...(req.reasoning === undefined ? {} : { reasoning: req.reasoning }),
          ...(req.include === undefined ? {} : { include: req.include }),
        }),
      });
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
      throw new TransportError(`Subscription request failed: ${message}`);
    }
    if (response.status === 401) {
      if (retried) throw new AuthError("Authentication was rejected after one refresh retry.");
      return send(req, true);
    }
    if (response.status === 429) throw rateLimit(response);
    if (!response.ok) {
      // Redact before truncating so a long secret cannot lose its closing delimiter first.
      const snippet = await redactedResponseSnippet(response);
      throw new TransportError(`Subscription transport failed (${response.status}): ${snippet}`);
    }
    if (response.body === null) throw new TransportError("Subscription transport returned no response stream.");
    return response;
  }

  async function* stream(req: ResponseRequest): AsyncIterable<ResponseEvent> {
    const response = await send(req, false);
    const rateLimits = parseRateLimitHeaders(response.headers);
    if (response.body === null) {
      captureRateLimits(rateLimits);
      return;
    }
    try { yield* parseSSE(response.body); }
    catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
      throw new TransportError(`Subscription stream failed: ${message}`);
    } finally { captureRateLimits(rateLimits); }
  }

  async function respond(req: ResponseRequest): Promise<ResponseResult> {
    const events: ResponseEvent[] = [];
    let outputText = "";
    let completed: unknown;
    for await (const event of stream(req)) {
      events.push(event);
      if (event.type === "response.output_text.delta" && event.delta !== undefined) outputText += event.delta;
      if (event.type === "response.completed") completed = event.data;
    }
    return { outputText, events, ...(completed === undefined ? {} : { response: completed }) };
  }

  return { respond, stream, get lastRateLimits() { return lastRateLimits; } };
}
