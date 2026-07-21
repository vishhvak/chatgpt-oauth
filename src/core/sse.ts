/** Incrementally frames SSE across arbitrary chunks, including multiline data and unknown events. */
import type { ResponseEvent } from "./types.js";

function parseBlock(block: string): ResponseEvent | null {
  let eventName = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") eventName = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const joined = data.join("\n");
  if (joined === "[DONE]") return { type: "done", data: null };
  let parsed: unknown = joined;
  try { parsed = JSON.parse(joined); } catch { /* Non-JSON SSE is valid and forwarded. */ }
  const record = parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  const type = typeof record?.type === "string" ? record.type : eventName;
  const delta = typeof record?.delta === "string" ? record.delta : undefined;
  return { type, data: parsed, ...(delta === undefined ? {} : { delta }) };
}

export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<ResponseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== null) {
          yield event;
          if (event.type === "done") return;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const final = parseBlock(buffer);
    if (final !== null) yield final;
  } finally {
    reader.releaseLock();
  }
}
