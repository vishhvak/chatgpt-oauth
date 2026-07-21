/** Implements the backend-api SubscriptionAI transport and its single reactive auth retry. */
import { PROTOCOL, type ProtocolOverrides } from "./constants.js";
import { redact } from "./redact.js";
import { parseSSE } from "./sse.js";
import {
  AuthError,
  RateLimitError,
  TransportError,
  type AuthSession,
  type ResponseEvent,
  type ResponseRequest,
  type ResponseResult,
  type SubscriptionAI,
} from "./types.js";

export interface ClientOptions {
  fetch?: typeof fetch;
  protocol?: ProtocolOverrides;
  sessionId?: string;
}

function rateLimit(response: Response): RateLimitError {
  const raw = response.headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw);
  return new RateLimitError(Number.isFinite(seconds) ? seconds * 1_000 : undefined);
}

export function createClient(session: AuthSession, subject: string, options: ClientOptions = {}): SubscriptionAI {
  const request = options.fetch ?? fetch;
  const endpoint = options.protocol?.RESPONSES_URL ?? PROTOCOL.RESPONSES_URL;
  const sessionId = options.sessionId ?? crypto.randomUUID();

  async function send(req: ResponseRequest, retried: boolean): Promise<Response> {
    const accessToken = retried
      ? await session.refreshAccessToken(subject)
      : await session.getAccessToken(subject);
    const status = await session.status(subject);
    const response = await request(endpoint, {
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
        input: req.input,
        ...(req.tools === undefined ? {} : { tools: req.tools }),
        ...(req.tool_choice === undefined ? {} : { tool_choice: req.tool_choice }),
        parallel_tool_calls: false,
        store: false,
        stream: true,
        ...(req.reasoning === undefined ? {} : { reasoning: req.reasoning }),
        ...(req.include === undefined ? {} : { include: req.include }),
      }),
    });
    if (response.status === 401) {
      if (retried) throw new AuthError("Authentication was rejected after one refresh retry.");
      return send(req, true);
    }
    if (response.status === 429) throw rateLimit(response);
    if (!response.ok) {
      const snippet = redact((await response.text()).slice(0, 1_024));
      throw new TransportError(`Subscription transport failed (${response.status}): ${snippet}`);
    }
    if (response.body === null) throw new TransportError("Subscription transport returned no response stream.");
    return response;
  }

  async function* stream(req: ResponseRequest): AsyncIterable<ResponseEvent> {
    const response = await send(req, false);
    if (response.body === null) return;
    yield* parseSSE(response.body);
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

  return { respond, stream };
}
