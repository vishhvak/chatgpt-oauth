/**
 * One auth session for the whole app, server-side only.
 *
 * The browser never sees a token. It POSTs an SDP offer to `/api/call` and the route attaches the
 * bearer; it POSTs a delegation prompt to `/api/delegate` and the route runs it. That keeps the
 * refresh token on the server, which is the identity rule this library is built around.
 *
 * `subject` is hardcoded here because the example has no login of its own. In a real app it comes
 * from your authenticated session and never from the request body.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createAuthSession } from "chatgpt-oauth";
import { createFileStore } from "chatgpt-oauth/node";

/**
 * Defaults to the subject `examples/verify.ts` uses, so signing in there signs you in here.
 * Set `CHATGPT_OAUTH_SUBJECT` if you signed in through a different example.
 */
export const SUBJECT = process.env.CHATGPT_OAUTH_SUBJECT ?? "example-user";

const store = await createFileStore({ directory: join(homedir(), ".chatgpt-oauth-example") });

export const auth = createAuthSession({ store });

export async function requireTokens(): Promise<{ accessToken: string; accountId?: string }> {
  if ((await auth.status(SUBJECT)) === null) {
    throw new Error(
      "No stored credentials. Run `pnpm dlx tsx examples/verify.ts` from typescript/ to sign in first.",
    );
  }
  const tokens = await auth.getTokenSet(SUBJECT);
  return {
    accessToken: tokens.accessToken,
    ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
  };
}
