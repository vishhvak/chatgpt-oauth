/**
 * Experimental Codex app-server transport. The required `chatgptAuthTokens` mode is
 * stamped "UNSTABLE - FOR OPENAI INTERNAL USE ONLY" and may change without notice.
 */
import { ChatGPTOAuthError, type AuthSession, type ResponseEvent, type ResponseRequest, type ResponseResult, type SubscriptionAI } from "../core/types.js";
import { redact } from "../core/redact.js";
import { AppServerError } from "./errors.js";
import { spawnAppServer } from "./process.js";
import { createRpcConnection, type RpcConnection } from "./rpc.js";

export { AppServerError, AppServerRpcError } from "./errors.js";

export interface AppServerClientOptions {
  codexBin?: string;
  codexHome?: string;
  env?: Record<string, string>;
  onNotification?: (notification: unknown) => void;
}

export type AppServerClient = SubscriptionAI & { close(): Promise<void> };

interface ThreadStartResult { thread?: { id?: unknown } }
interface TurnStartResult { turn?: { id?: unknown } }

interface EventQueue {
  push(event: ResponseEvent): void;
  end(): void;
  fail(error: unknown): void;
  iterable: AsyncIterable<ResponseEvent>;
}

function createEventQueue(): EventQueue {
  const values: ResponseEvent[] = [];
  const waiters: Array<{ resolve(value: IteratorResult<ResponseEvent>): void; reject(error: unknown): void }> = [];
  let ended = false;
  let failure: unknown;
  return {
    push(event) {
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(event);
      else waiter.resolve({ done: false, value: event });
    },
    end() { ended = true; for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); },
    fail(error) { failure = error; for (const waiter of waiters.splice(0)) waiter.reject(error); },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ResponseEvent>> {
            const value = values.shift();
            if (value !== undefined) return Promise.resolve({ done: false, value });
            if (failure !== undefined) return Promise.reject(failure);
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
          },
        };
      },
    },
  };
}

function typedFailure(error: unknown, context: string): ChatGPTOAuthError {
  if (error instanceof ChatGPTOAuthError) return error;
  return new AppServerError(`${context}: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 1_024)}`);
}

function userInput(input: ResponseRequest["input"]): Array<Record<string, unknown>> {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  const result: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item.type === "text" && typeof item.text === "string") result.push(item);
    else if (item.type === "input_text" && typeof item.text === "string") result.push({ type: "text", text: item.text, text_elements: [] });
    else if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content !== null && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string") {
          result.push({ type: "text", text: (content as Record<string, string>).text, text_elements: [] });
        }
      }
    } else result.push(item);
  }
  return result;
}

function tokenMetadata(status: Awaited<ReturnType<AuthSession["status"]>>): { chatgptAccountId: string; chatgptPlanType: string | null } {
  if (status?.accountId === undefined) throw new AppServerError("Codex app-server auth requires chatgptAccountId routing metadata.");
  return { chatgptAccountId: status.accountId, chatgptPlanType: status.planType ?? null };
}

/**
 * Creates an experimental Node-only transport backed by `codex app-server`.
 * The app-server receives only host-managed access tokens and an isolated CODEX_HOME.
 */
export async function createAppServerClient(
  auth: AuthSession,
  subject: string,
  options: AppServerClientOptions = {},
): Promise<AppServerClient> {
  const processHandle = await spawnAppServer(options);
  let threadId: string | undefined;
  let threadPromise: Promise<string> | undefined;
  let active: { queue: EventQueue; threadId: string; turnId?: string } | undefined;

  function handleNotification(notification: { method: string; params?: unknown }): void {
    const params = notification.params !== null && typeof notification.params === "object"
      ? notification.params as Record<string, unknown>
      : {};
    if (active !== undefined && notification.method === "turn/started") {
      const turn = params.turn;
      const id = turn !== null && typeof turn === "object" ? (turn as Record<string, unknown>).id : undefined;
      if (typeof id === "string") active.turnId = id;
      return;
    }
    if (active !== undefined && notification.method === "item/agentMessage/delta" && params.threadId === active.threadId) {
      if (active.turnId !== undefined && params.turnId !== active.turnId) return;
      if (typeof params.delta === "string") {
        active.queue.push({ type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: params.delta }, delta: params.delta });
      }
      return;
    }
    if (active !== undefined && notification.method === "turn/completed" && params.threadId === active.threadId) {
      const turn = params.turn;
      if (turn === null || typeof turn !== "object") return;
      const record = turn as Record<string, unknown>;
      if (active.turnId !== undefined && record.id !== active.turnId) return;
      if (record.status === "failed" || record.status === "interrupted") {
        active.queue.fail(new AppServerError(`Codex turn ${String(record.status)}: ${redact(JSON.stringify(record.error ?? "unknown")).slice(0, 1_024)}`));
      } else {
        active.queue.push({ type: "response.completed", data: params });
        active.queue.end();
      }
      active = undefined;
      return;
    }
    options.onNotification?.(notification);
  }

  const rpc: RpcConnection = createRpcConnection(processHandle.child, {
    onNotification: handleNotification,
    async onServerRequest(request) {
      if (request.method !== "account/chatgptAuthTokens/refresh") throw new AppServerError(`Unsupported server request: ${request.method}`);
      try {
        const accessToken = await auth.refreshAccessToken(subject);
        return { accessToken, ...tokenMetadata(await auth.status(subject)) };
      } catch (error) {
        const failure = typedFailure(error, "Codex token refresh failed");
        active?.queue.fail(failure);
        active = undefined;
        throw failure;
      }
    },
    onServerRequestError(error) {
      if (active !== undefined) {
        active.queue.fail(typedFailure(error, "Codex server request failed"));
        active = undefined;
      }
    },
  });

  try {
    await rpc.request("initialize", {
      clientInfo: { name: "chatgpt-oauth", title: "ChatGPT OAuth App Server", version: "0.1.0" },
    });
    rpc.notify("initialized");
    const accessToken = await auth.getAccessToken(subject);
    await rpc.request("account/login/start", { type: "chatgptAuthTokens", accessToken, ...tokenMetadata(await auth.status(subject)) });
  } catch (error) {
    rpc.close();
    await processHandle.close();
    throw typedFailure(error, "Codex app-server initialization failed");
  }

  function ensureThread(req: ResponseRequest): Promise<string> {
    if (threadId !== undefined) return Promise.resolve(threadId);
    threadPromise ??= rpc.request<ThreadStartResult>("thread/start", {
      model: req.model,
      ...(req.instructions === undefined ? {} : { baseInstructions: req.instructions }),
      ephemeral: true,
    }).then((result) => {
      if (typeof result.thread?.id !== "string") throw new AppServerError("Codex thread/start omitted thread.id.");
      threadId = result.thread.id;
      return threadId;
    });
    return threadPromise;
  }

  async function* stream(req: ResponseRequest): AsyncIterable<ResponseEvent> {
    const currentThread = await ensureThread(req);
    if (active !== undefined) throw new AppServerError("Codex app-server supports one active turn per client.");
    const queue = createEventQueue();
    active = { queue, threadId: currentThread };
    try {
      const result = await rpc.request<TurnStartResult>("turn/start", {
        threadId: currentThread,
        input: userInput(req.input),
        model: req.model,
        ...(typeof req.reasoning?.effort === "string" ? { effort: req.reasoning.effort } : {}),
      });
      if (active !== undefined && typeof result.turn?.id === "string") active.turnId ??= result.turn.id;
    } catch (error) {
      const failure = typedFailure(error, "Codex turn/start failed");
      active?.queue.fail(failure);
      active = undefined;
    }
    yield* queue.iterable;
  }

  async function respond(req: ResponseRequest): Promise<ResponseResult> {
    const events: ResponseEvent[] = [];
    let outputText = "";
    let response: unknown;
    for await (const event of stream(req)) {
      events.push(event);
      if (event.type === "response.output_text.delta" && event.delta !== undefined) outputText += event.delta;
      if (event.type === "response.completed") response = event.data;
    }
    return { outputText, events, ...(response === undefined ? {} : { response }) };
  }

  return {
    respond,
    stream,
    async close() {
      const failure = new AppServerError("Codex app-server client closed.");
      active?.queue.fail(failure);
      active = undefined;
      rpc.close(failure);
      await processHandle.close();
    },
  };
}
