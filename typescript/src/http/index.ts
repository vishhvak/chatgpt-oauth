/** Serves the whole browser login lifecycle from one fetch handler, keeping tokens server-side. */
import { createAuthorizationRedirect, completeAuthorizationRedirect } from "../web/index.js";
import { AuthError, StateMismatchError, type AuthSession, type PendingLogin } from "../core/types.js";

/** Custody for the in-flight `state`/`verifier` pair between the redirect and the callback. */
export interface PendingLoginStore {
  save(subject: string, pending: PendingLogin): Promise<void>;
  /** Returns the pending login and consumes it; a replayed callback must find nothing. */
  take(subject: string): Promise<PendingLogin | null>;
}

export interface ChatGPTHandlerOptions {
  /**
   * Derives the application's own user identity from the request. This must come from
   * your trusted session — never from a query parameter, header, or request body.
   */
  subject: (request: Request) => string | Promise<string>;
  /** Where the login lifecycle is mounted; the callback URL is built from it. */
  basePath?: string;
  /** Where the browser lands after a completed callback. */
  redirectTo?: string;
  /** Defaults to an encrypted, short-lived, httpOnly cookie. Supply your own to use a database. */
  pending?: PendingLoginStore;
  /** Required by the default cookie store: 32+ random bytes, from your secret manager. */
  secret?: string;
}

const PENDING_COOKIE = "chatgpt_oauth_pending";
const PENDING_TTL_SECONDS = 600;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function keyFrom(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/**
 * Encrypts the pending login into the response cookie.
 *
 * The subject is sealed *inside* the ciphertext and re-checked on the way out, so a
 * cookie captured from one signed-in user cannot complete a login for another.
 */
async function seal(secret: string, subject: string, pending: PendingLogin): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ subject, pending, expiresAt: Date.now() + PENDING_TTL_SECONDS * 1_000 }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(secret), plaintext));
  return `${base64url(iv)}.${base64url(sealed)}`;
}

async function open(secret: string, subject: string, cookie: string): Promise<PendingLogin | null> {
  const [rawIv, rawBody] = cookie.split(".");
  if (rawIv === undefined || rawBody === undefined) return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(rawIv) },
      await keyFrom(secret),
      fromBase64url(rawBody),
    );
    const payload = JSON.parse(new TextDecoder().decode(opened)) as {
      subject?: unknown; pending?: PendingLogin; expiresAt?: unknown;
    };
    if (payload.subject !== subject) return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    return payload.pending ?? null;
  } catch {
    // Tampered, truncated, or encrypted under a rotated secret: treat as no pending login.
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** `Secure` is dropped on plain-http origins so local development works without a proxy. */
function cookieAttributes(url: URL, maxAge: number): string {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `Path=/; Max-Age=${maxAge}; HttpOnly;${secure} SameSite=Lax`;
}

function expiredCookie(url: URL): string {
  return `${PENDING_COOKIE}=; ${cookieAttributes(url, 0)}`;
}

/**
 * Builds the `/login`, `/callback`, `/session`, and `/logout` routes as one fetch handler.
 *
 * Only safe session metadata (`status`, `email`, `planType`) ever reaches the browser.
 */
export function createChatGPTHandler(
  auth: AuthSession,
  options: ChatGPTHandlerOptions,
): (request: Request) => Promise<Response> {
  const basePath = (options.basePath ?? "/api/chatgpt").replace(/\/$/u, "");
  const redirectTo = options.redirectTo ?? "/";
  const custom = options.pending;
  if (custom === undefined && options.secret === undefined) {
    // A construction-time programmer error, not a runtime auth failure — so not a ChatGPTOAuthError.
    throw new TypeError("createChatGPTHandler requires either `secret` or a `pending` store.");
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
    const subject = await options.subject(request);

    if (route === "/session" && request.method === "GET") {
      const session = await auth.status(subject);
      return json(session === null
        ? { status: "signed-out" }
        : { status: session.status, email: session.email, planType: session.planType });
    }

    if (route === "/login" && request.method === "POST") {
      const pending = await createAuthorizationRedirect(auth, `${url.origin}${basePath}/callback`);
      if (custom !== undefined) {
        await custom.save(subject, pending);
        return json({ url: pending.url });
      }
      const cookie = await seal(options.secret as string, subject, pending);
      return json({ url: pending.url }, 200, {
        "set-cookie": `${PENDING_COOKIE}=${cookie}; ${cookieAttributes(url, PENDING_TTL_SECONDS)}`,
      });
    }

    if (route === "/callback" && request.method === "GET") {
      const raw = custom === undefined ? readCookie(request, PENDING_COOKIE) : null;
      const pending = custom !== undefined
        ? await custom.take(subject)
        : raw === null ? null : await open(options.secret as string, subject, raw);
      if (pending === null) return json({ error: "no_pending_login" }, 400, { "set-cookie": expiredCookie(url) });
      try {
        await completeAuthorizationRedirect(auth, subject, url, pending);
      } catch (error) {
        // A mismatched state or a rejected code is a probe against the callback, not a server fault.
        if (error instanceof StateMismatchError || error instanceof AuthError) {
          return json({ error: error.code }, 400, { "set-cookie": expiredCookie(url) });
        }
        throw error;
      }
      return new Response(null, {
        status: 302,
        headers: { location: redirectTo, "set-cookie": expiredCookie(url), "cache-control": "no-store" },
      });
    }

    if (route === "/logout" && request.method === "POST") {
      await auth.logout(subject);
      return json({ status: "signed-out" });
    }

    return json({ error: "not_found" }, 404);
  };
}
