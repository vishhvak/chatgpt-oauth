/** Implements the deliberately tiny signed-cookie session used only by this template. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "render_service_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Signs the subject together with its issue time so the expiry is verified by the server. */
function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function cookieValue(subject: string, secret: string, issuedAt: number): string {
  const payload = `${subject}.${issuedAt}`;
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

function readCookie(request: IncomingMessage, secret: string, now: number): string | null {
  const pair = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (pair === undefined) return null;
  const value = pair.slice(COOKIE_NAME.length + 1);
  // Split from the right twice: the subject itself may contain a dot.
  const signatureAt = value.lastIndexOf(".");
  if (signatureAt < 1) return null;
  const payload = value.slice(0, signatureAt);
  const issuedAtAt = payload.lastIndexOf(".");
  if (issuedAtAt < 1) return null;
  const subject = payload.slice(0, issuedAtAt);
  const issuedAt = Number(payload.slice(issuedAtAt + 1));

  const supplied = Buffer.from(value.slice(signatureAt + 1), "base64url");
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  // A Max-Age attribute is only a hint to the browser; the server has to enforce the window itself,
  // or a captured cookie stays valid forever.
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || now - issuedAt > MAX_AGE_MS) return null;
  return subject;
}

export function requireDemoSubject(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  secure: boolean,
): string {
  // DEMO auth — replace with your product's real session. subject MUST be
  // server-derived, never from the request body.
  const now = Date.now();
  const existing = readCookie(request, secret, now);
  if (existing !== null) return existing;
  const subject = randomUUID();
  response.setHeader("set-cookie", [
    `${COOKIE_NAME}=${cookieValue(subject, secret, now)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1_000}${secure ? "; Secure" : ""}`,
  ]);
  return subject;
}
