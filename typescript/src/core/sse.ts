/** Incrementally frames SSE across arbitrary chunks, including multiline data and unknown events. */
import type { ResponseEvent } from "./types.js";

function parseBlock(block: string): ResponseEvent | "done" | null {
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
  if (joined === "[DONE]") return "done";
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
      // `buffer` is already normalized, so only the newly decoded suffix needs normalizing, and a
      // new "\n\n" can only appear at the join between the two. Re-normalizing and re-scanning the
      // whole accumulated buffer per chunk is O(n^2) for one large event split across many small
      // chunks — the same fix the Python, Kotlin and Swift ports already carry.
      // A CR held back from the previous chunk rejoins this one so a split CRLF collapses to one
      // newline; the boundary search then starts one character early to span the join.
      const pendingCr = buffer.endsWith("\r");
      if (pendingCr) buffer = buffer.slice(0, -1);
      const searchFrom = Math.max(0, buffer.length - 1);
      const decoded = decoder.decode(value, { stream: !done });
      const raw = pendingCr ? `\r${decoded}` : decoded;
      buffer += done
        ? raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
        : raw.replaceAll("\r\n", "\n").replace(/\r(?!$)/gu, "\n");
      let boundary = buffer.indexOf("\n\n", searchFrom);
      while (boundary !== -1) {
        const event = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event === "done") return;
        if (event !== null) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const final = parseBlock(buffer);
    if (final !== null && final !== "done") yield final;
  } finally {
    reader.releaseLock();
  }
}
