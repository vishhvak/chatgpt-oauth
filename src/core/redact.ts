/** Scrubs token-shaped secrets before untrusted server text reaches errors or logs. */
const REDACTED = "[REDACTED]";

export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;"']+/giu, `Bearer ${REDACTED}`)
    .replace(/(["']?(?:access_token|refresh_token|id_token|authorization)["']?\s*:\s*["'])[^"']*(["'])/giu, `$1${REDACTED}$2`)
    .replace(/\b(access_token|refresh_token|id_token|authorization)=([^&\s]+)/giu, `$1=${REDACTED}`);
}
