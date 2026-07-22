/** Decodes unverified JWT display/routing claims; none of these values may gate authorization. */
import { decodeBase64url } from "./pkce.js";

const CLAIM_NAMESPACE = "https://api.openai.com/auth";

export interface UnverifiedClaims {
  accountId?: string;
  planType?: string;
  email?: string;
}

function decodePayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(payload)));
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The returned claims are unverified and suitable only for display and request routing. */
export function extractUnverifiedClaims(idToken?: string, accessToken?: string): UnverifiedClaims {
  const payload = decodePayload(idToken ?? "") ?? decodePayload(accessToken ?? "") ?? {};
  const namespace = payload[CLAIM_NAMESPACE];
  const auth = namespace !== null && typeof namespace === "object" ? namespace as Record<string, unknown> : {};
  const claims: UnverifiedClaims = {};
  if (typeof auth.chatgpt_account_id === "string") claims.accountId = auth.chatgpt_account_id;
  if (typeof auth.chatgpt_plan_type === "string") claims.planType = auth.chatgpt_plan_type;
  if (typeof payload.email === "string") claims.email = payload.email;
  return claims;
}
