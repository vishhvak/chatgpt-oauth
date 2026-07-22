/** Implements the deliberately tiny signed-cookie session used only by this template. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "render_service_session";

function signature(subject: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(subject).digest();
}

function cookieValue(subject: string, secret: string): string {
  return `${subject}.${signature(subject, secret).toString("base64url")}`;
}

function readCookie(request: IncomingMessage, secret: string): string | null {
  const pair = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (pair === undefined) return null;
  const value = pair.slice(COOKIE_NAME.length + 1);
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const subject = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = signature(subject, secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? subject : null;
}

export function requireDemoSubject(
  request: IncomingMessage,
  response: ServerResponse,
  secret: string,
  secure: boolean,
): string {
  // DEMO auth — replace with your product's real session. subject MUST be
  // server-derived, never from the request body.
  const existing = readCookie(request, secret);
  if (existing !== null) return existing;
  const subject = randomUUID();
  response.setHeader("set-cookie", [
    `${COOKIE_NAME}=${cookieValue(subject, secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? "; Secure" : ""}`,
  ]);
  return subject;
}
