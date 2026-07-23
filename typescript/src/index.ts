/** Public core entry point: runtime-neutral auth, storage contracts, and subscription transport. */
export { PROTOCOL, protocolWith } from "./core/constants.js";
export type { ProtocolConfig, ProtocolOverrides } from "./core/constants.js";
export { createMemoryStore } from "./core/memory-store.js";
export { createAuthSession } from "./core/lifecycle.js";
export type { AuthSessionOptions } from "./core/lifecycle.js";
export { createClient } from "./core/client.js";
export type { ClientOptions } from "./core/client.js";
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
