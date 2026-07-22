/** Provides redirect/callback primitives while keeping token exchange and subjects server-side. */
import { assertState } from "../core/pkce.js";
import { AuthError, type AuthSession, type PendingLogin, type TokenSet } from "../core/types.js";

export async function createAuthorizationRedirect(
  session: AuthSession,
  redirectUri: string,
): Promise<PendingLogin> {
  return session.beginLogin(redirectUri);
}

export function parseAuthorizationCallback(callback: string | URL, expectedState: string): {
  code: string;
  url: URL;
} {
  const url = callback instanceof URL ? callback : new URL(callback);
  assertState(expectedState, url.searchParams.get("state"));
  const error = url.searchParams.get("error");
  if (error !== null) throw new AuthError("Authorization callback was rejected.");
  const code = url.searchParams.get("code");
  if (code === null || code === "") throw new AuthError("Authorization callback omitted the code.");
  return { code, url };
}

export async function completeAuthorizationRedirect(
  session: AuthSession,
  subject: string,
  callback: string | URL,
  pending: PendingLogin,
): Promise<TokenSet> {
  parseAuthorizationCallback(callback, pending.state);
  return session.completeLogin(subject, callback, pending);
}
