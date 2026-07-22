/** Implements newline-JSON RPC dispatch, overload retry, and server-to-host replies. */
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { redact } from "../core/redact.js";
import { AppServerError, AppServerRpcError } from "./errors.js";

interface RpcErrorShape { code: number; message: string }
interface RpcMessage { id?: number; method?: string; params?: unknown; result?: unknown; error?: RpcErrorShape }

export interface RpcConnectionOptions {
  onNotification(notification: { method: string; params?: unknown }): void;
  onServerRequest(request: { id: number; method: string; params?: unknown }): Promise<unknown>;
  onServerRequestError(error: unknown): void;
  onClose(error: AppServerError): void;
}

export interface RpcConnection {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(error?: AppServerError): void;
}

function safeMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}

export function createRpcConnection(child: ChildProcessWithoutNullStreams, options: RpcConnectionOptions): RpcConnection {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  let stderr = "";

  function write(message: RpcMessage): void {
    if (closed) throw new AppServerError("Codex app-server connection is closed.");
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error !== null && error !== undefined) close(new AppServerError(`Codex app-server write failed: ${safeMessage(error)}`));
    });
  }

  function close(error = new AppServerError("Codex app-server connection closed.")): void {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    options.onClose(error);
  }

  async function handleServerRequest(message: Required<Pick<RpcMessage, "id" | "method">> & RpcMessage): Promise<void> {
    try {
      const result = await options.onServerRequest({ id: message.id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
      if (!closed) write({ id: message.id, result });
    } catch (error) {
      try { options.onServerRequestError(error); }
      catch { /* A host callback cannot escape the protocol dispatcher. */ }
      if (!closed) write({ id: message.id, error: { code: -32603, message: safeMessage(error) } });
    }
  }

  function handle(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) request.reject(new AppServerRpcError(message.error.code, redact(message.error.message).slice(0, 1_024), request.method));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      void handleServerRequest(message as Required<Pick<RpcMessage, "id" | "method">> & RpcMessage)
        .catch((error: unknown) => { if (!closed) close(new AppServerError(`Codex server request reply failed: ${safeMessage(error)}`)); });
      return;
    }
    if (message.method !== undefined) options.onNotification({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
  }

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    try { handle(JSON.parse(line) as RpcMessage); }
    catch (error) { close(new AppServerError(`Codex app-server sent invalid JSON: ${safeMessage(error)}; ${redact(line).slice(0, 256)}`)); }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096); });
  child.once("error", (error) => { close(new AppServerError(`Codex app-server process error: ${safeMessage(error)}`)); });
  child.once("exit", (code, signal) => {
    if (!closed) close(new AppServerError(`Codex app-server exited (${signal ?? code ?? "unknown"}): ${redact(stderr).slice(0, 1_024)}`));
  });

  function requestOnce<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      // Register before writing because a scripted binary can answer in the same tick.
      pending.set(id, { method, resolve: (value) => { resolve(value as T); }, reject });
      try { write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  async function request<T>(method: string, params?: unknown): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try { return await requestOnce<T>(method, params); }
      catch (error) {
        if (!(error instanceof AppServerRpcError) || error.rpcCode !== -32_001 || retry >= 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * 2 ** retry));
      }
    }
  }

  return { request, notify: (method, params) => { write({ method, ...(params === undefined ? {} : { params }) }); }, close };
}
