/** Owns OAuth wire calls, token normalization, device polling, and terminal-error classification. */
import { protocolWith, type ProtocolOverrides } from "./constants.js";
import { extractUnverifiedClaims } from "./jwt.js";
import { assertState, createPkce } from "./pkce.js";
import { readRedactedResponse, redact } from "./redact.js";
import {
  AuthError,
  RateLimitError,
  TokenRefreshError,
  TransportError,
  type PendingLogin,
  type TokenSet,
} from "./types.js";

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

interface DeviceStartPayload {
  user_code?: unknown;
  usercode?: unknown;
  device_auth_id?: unknown;
  interval?: unknown;
  expires_in?: unknown;
}

function sanitizedCause(cause: unknown): Error {
  return new Error(redact(cause instanceof Error ? cause.message : String(cause)));
}

export class TokenEndpointFailure extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    readonly terminal: boolean,
    message: string,
  ) { super(message); }
}

export interface OAuthRuntime {
  fetch?: typeof fetch;
  crypto?: Crypto;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  protocol?: ProtocolOverrides;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function failure(response: Response, context: string): Promise<never> {
  // Redact before truncating; a cut closing quote must never defeat the JSON scrubber.
  const body = await readRedactedResponse(response, 65_536);
  const snippet = body.slice(0, 1_024);
  let errorCode: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      const error = (parsed as Record<string, unknown>).error;
      errorCode = typeof error === "string" ? error :
        error !== null && typeof error === "object" && typeof (error as Record<string, unknown>).code === "string"
          ? (error as Record<string, string>).code
          : undefined;
    }
  } catch { /* An opaque response still gets a typed, redacted failure. */ }
  if (response.status === 429) throw new RateLimitError(retryAfter(response));
  const terminal = response.status === 401 || response.status === 403 ||
    (response.status >= 400 && response.status < 500 &&
      ["invalid_grant", "invalid_token", "invalid_request"].includes(errorCode ?? ""));
  if (context === "refresh") {
    throw new TokenEndpointFailure(response.status, errorCode, terminal, `${context} failed (${response.status}): ${snippet}`);
  }
  throw new AuthError(`${context} failed (${response.status}): ${snippet}`);
}

function normalizeToken(payload: TokenPayload, now: number, previous?: TokenSet): TokenSet {
  if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
    throw new TransportError("Token endpoint returned an invalid response.");
  }
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : previous?.refreshToken;
  if (refreshToken === undefined) throw new TransportError("Token endpoint omitted the refresh token.");
  const idToken = typeof payload.id_token === "string" ? payload.id_token : previous?.idToken;
  const claims = extractUnverifiedClaims(idToken, payload.access_token);
  return {
    accessToken: payload.access_token,
    refreshToken,
    ...(idToken === undefined ? {} : { idToken }),
    expiresAt: now + payload.expires_in * 1_000,
    ...claims,
    version: (previous?.version ?? 0) + 1,
  };
}

async function json<T>(response: Response): Promise<T> {
  try { return await response.json() as T; }
  catch (cause) { throw new TransportError("OAuth endpoint returned invalid JSON.", { cause }); }
}

export function createOAuth(runtime: OAuthRuntime = {}) {
  const request = runtime.fetch ?? fetch;
  const webCrypto = runtime.crypto ?? crypto;
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const protocol = protocolWith(runtime.protocol);

  async function beginLogin(redirectUri = protocol.LOOPBACK_REDIRECT): Promise<PendingLogin> {
    const generated = await createPkce(webCrypto);
    const url = new URL(protocol.AUTHORIZE_URL);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: protocol.CLIENT_ID,
      redirect_uri: redirectUri,
      scope: protocol.SCOPES,
      code_challenge: generated.challenge,
      code_challenge_method: "S256",
      state: generated.state,
      ...protocol.EXTRA_AUTH_PARAMS,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { url: url.toString(), state: generated.state, verifier: generated.verifier, redirectUri };
  }

  async function exchange(code: string, verifier: string, redirectUri: string, previous?: TokenSet): Promise<TokenSet> {
    let response: Response;
    try {
      response = await request(protocol.TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: protocol.CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
    } catch (cause) {
      throw new TransportError("Authorization code exchange failed due to a network error.", { cause: sanitizedCause(cause) });
    }
    if (!response.ok) await failure(response, "code exchange");
    return normalizeToken(await json<TokenPayload>(response), now(), previous);
  }

  async function completeLogin(callbackUrl: string | URL, pending: PendingLogin): Promise<TokenSet> {
    const callback = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
    // State is checked before code/error reads so an attacker cannot select a different failure path.
    assertState(pending.state, callback.searchParams.get("state"));
    const oauthError = callback.searchParams.get("error");
    if (oauthError !== null) throw new AuthError(`Authorization failed: ${redact(oauthError)}`);
    const code = callback.searchParams.get("code");
    if (code === null || code === "") throw new AuthError("Authorization callback omitted the code.");
    return exchange(code, pending.verifier, pending.redirectUri);
  }

  async function refresh(previous: TokenSet): Promise<TokenSet> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await request(protocol.TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: protocol.CLIENT_ID,
            refresh_token: previous.refreshToken,
            scope: protocol.SCOPES,
          }),
        });
      } catch (cause) {
        if (attempt < 2) { await sleep(250 * 2 ** attempt); continue; }
        throw new TokenRefreshError("Token refresh failed due to a network error.", { cause: sanitizedCause(cause) });
      }
      if (response.status >= 500 && attempt < 2) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 && attempt < 2) {
        await sleep(retryAfter(response) ?? 250 * 2 ** attempt);
        continue;
      }
      if (!response.ok) await failure(response, "refresh");
      try { return normalizeToken(await json<TokenPayload>(response), now(), previous); }
      catch (cause) {
        throw new TokenRefreshError("Token refresh returned an invalid response.", { cause });
      }
    }
    throw new TokenRefreshError();
  }

  async function startDeviceLogin(onComplete: (tokens: TokenSet) => Promise<TokenSet>) {
    let response: Response;
    try {
      response = await request(protocol.DEVICE_USERCODE_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: protocol.CLIENT_ID }),
      });
    } catch (cause) {
      throw new TransportError("Device authorization failed due to a network error.", { cause: sanitizedCause(cause) });
    }
    if (!response.ok) await failure(response, "device authorization");
    const payload = await json<DeviceStartPayload>(response);
    const userCode = typeof payload.user_code === "string" ? payload.user_code : payload.usercode;
    if (typeof userCode !== "string" || typeof payload.device_auth_id !== "string") {
      throw new TransportError("Device authorization returned an invalid response.");
    }
    let interval = (typeof payload.interval === "number" ? payload.interval : 5) * 1_000;
    const expiresAt = now() + (typeof payload.expires_in === "number" ? payload.expires_in : 900) * 1_000;
    return {
      userCode,
      verificationUrl: protocol.DEVICE_VERIFY_URL,
      expiresAt,
      async wait(): Promise<TokenSet> {
        while (now() < expiresAt) {
          await sleep(interval);
          if (now() >= expiresAt) break;
          let poll: Response;
          try {
            poll = await request(protocol.DEVICE_POLL_URL, {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({ device_auth_id: payload.device_auth_id, user_code: userCode }),
            });
          } catch (cause) {
            throw new TransportError("Device authorization poll failed due to a network error.", { cause: sanitizedCause(cause) });
          }
          let pollBody: Record<string, unknown> = {};
          try { pollBody = await json<Record<string, unknown>>(poll); }
          catch (error) {
            if (poll.status !== 403 && poll.status !== 404) throw error;
          }
          const pollError = typeof pollBody.error === "string" ? pollBody.error : undefined;
          if (pollError === "authorization_pending" || poll.status === 403 || poll.status === 404) {
            continue;
          }
          if (pollError === "slow_down") {
            interval += 5_000;
            continue;
          }
          if (!poll.ok) throw new AuthError(`Device authorization failed (${poll.status}).`);
          if (typeof pollBody.authorization_code !== "string" || typeof pollBody.code_verifier !== "string") {
            throw new TransportError("Device poll returned an invalid success response.");
          }
          return onComplete(await exchange(
            pollBody.authorization_code,
            pollBody.code_verifier,
            protocol.DEVICE_REDIRECT_URL,
          ));
        }
        throw new AuthError("Device authorization expired.");
      },
    };
  }

  return { protocol, beginLogin, completeLogin, refresh, startDeviceLogin };
}
