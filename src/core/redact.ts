/** Scrubs token-shaped secrets before untrusted server text reaches errors or logs. */
const REDACTED = "[REDACTED]";

export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;"']+/giu, `Bearer ${REDACTED}`)
    .replace(/("(?:access_token|refresh_token|id_token|authorization)"\s*:\s*")((?:\\.|[^"\\])*(?:\\(?=$))?)("|$)/giu, `$1${REDACTED}$3`)
    .replace(/('(?:access_token|refresh_token|id_token|authorization)'\s*:\s*')((?:\\.|[^'\\])*(?:\\(?=$))?)('|$)/giu, `$1${REDACTED}$3`)
    .replace(/\b(access_token|refresh_token|id_token|authorization)=([^&\s]+)/giu, `$1=${REDACTED}`);
}

export async function readRedactedResponse(response: Response, readLimit = 4_096): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length < readLimit) {
      const next = await reader.read();
      const decoded = decoder.decode(next.value, { stream: !next.done });
      value += decoded.slice(0, readLimit - value.length);
      if (next.done) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    value += ` [response read failed: ${redact(message)}]`;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  // The JSON pattern also matches end-of-string, so a truncated credential is still scrubbed.
  return redact(value.slice(0, readLimit));
}

export async function redactedResponseSnippet(response: Response, readLimit = 4_096, outputLimit = 1_024): Promise<string> {
  return (await readRedactedResponse(response, readLimit)).slice(0, outputLimit);
}
