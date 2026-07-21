/** Public core entry point: runtime-neutral auth, storage contracts, and subscription transport. */
export { PROTOCOL, protocolWith } from "./core/constants.js";
export type { ProtocolConfig, ProtocolOverrides } from "./core/constants.js";
export { createPkce, pkceChallenge, assertState } from "./core/pkce.js";
export { extractUnverifiedClaims } from "./core/jwt.js";
export type { UnverifiedClaims } from "./core/jwt.js";
export { redact } from "./core/redact.js";
export { createMemoryStore } from "./core/memory-store.js";
export { createAuthSession } from "./core/lifecycle.js";
export type { AuthSessionOptions } from "./core/lifecycle.js";
export { createClient } from "./core/client.js";
export type { BackendApiClient, ClientOptions } from "./core/client.js";
export { parseSSE } from "./core/sse.js";
export {
  ChatGPTOAuthError,
  StateMismatchError,
  ReauthRequiredError,
  TokenRefreshError,
  RateLimitError,
  AuthError,
  TransportError,
  DisabledError,
  StoreError,
} from "./core/types.js";
export type {
  AuthSession,
  CredentialStore,
  DeviceLogin,
  PendingLogin,
  RateLimitSnapshot,
  RateLimitWindow,
  ResponseEvent,
  ResponseRequest,
  ResponseResult,
  Session,
  SubscriptionAI,
  TokenSet,
} from "./core/types.js";
