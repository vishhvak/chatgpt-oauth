/** Defines the public data contracts and typed failures shared by every runtime. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch milliseconds with no refresh margin baked in. */
  expiresAt: number;
  /** Unverified routing metadata. Never use it to authorize a user. */
  accountId?: string;
  /** Unverified display metadata. */
  planType?: string;
  /** Unverified display metadata. */
  email?: string;
  /** Monotonically increasing compare-and-swap version. */
  version: number;
  quarantinedAt?: number;
  quarantineReason?: string;
}

export interface CredentialStore {
  load(subject: string): Promise<TokenSet | null>;
  compareAndSwap(
    subject: string,
    expectedVersion: number,
    next: TokenSet,
  ): Promise<{ ok: boolean; current: TokenSet | null }>;
  delete(subject: string): Promise<void>;
}

export interface PendingLogin {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export interface DeviceLogin {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  wait(): Promise<TokenSet>;
}

export interface Session {
  subject: string;
  status: "connected" | "quarantined";
  expiresAt: number;
  accountId?: string;
  planType?: string;
  email?: string;
  reason?: string;
}

export interface AuthSession {
  beginLogin(redirectUri?: string): Promise<PendingLogin>;
  completeLogin(subject: string, callbackUrl: string | URL, pending: PendingLogin): Promise<TokenSet>;
  startDeviceLogin(subject: string): Promise<DeviceLogin>;
  getAccessToken(subject: string): Promise<string>;
  refreshAccessToken(subject: string): Promise<string>;
  /** One store read (or one refresh) for both the bearer and `accountId`; `forceRefresh` skips the freshness check. */
  getTokenSet(subject: string, forceRefresh?: boolean): Promise<TokenSet>;
  status(subject: string): Promise<Session | null>;
  logout(subject: string): Promise<void>;
}

export type ResponseContent = string | ReadonlyArray<Record<string, unknown>>;

export interface ResponseRequest {
  model: string;
  input: ResponseContent;
  instructions?: string;
  tools?: ReadonlyArray<Record<string, unknown>>;
  tool_choice?: unknown;
  reasoning?: Record<string, unknown>;
  include?: readonly string[];
}

export interface ResponseEvent {
  type: string;
  data: unknown;
  delta?: string;
}

export interface ResponseResult {
  outputText: string;
  events: ResponseEvent[];
  response?: unknown;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  /** Epoch seconds. */
  resetsAt?: number;
}

export interface RateLimitSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  planType?: string;
  limitName?: string;
}

export interface SubscriptionAI {
  respond(req: ResponseRequest): Promise<ResponseResult>;
  stream(req: ResponseRequest): AsyncIterable<ResponseEvent>;
  /** Direct-backend clients expose the rate-limit snapshot from the most recent response. */
  readonly lastRateLimits?: RateLimitSnapshot | undefined;
}

export type ErrorCode =
  | "state_mismatch"
  | "reauth_required"
  | "token_refresh"
  | "rate_limit"
  | "auth"
  | "transport"
  | "disabled"
  | "store";

export class ChatGPTOAuthError extends Error {
  constructor(message: string, readonly code: ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class StateMismatchError extends ChatGPTOAuthError {
  constructor() { super("OAuth state did not match.", "state_mismatch"); }
}

export class ReauthRequiredError extends ChatGPTOAuthError {
  constructor(readonly subject: string, readonly reason: string) {
    super(`Fresh sign-in required for subject ${JSON.stringify(subject)}: ${reason}`, "reauth_required");
  }
}

export class TokenRefreshError extends ChatGPTOAuthError {
  constructor(message = "Token refresh failed transiently.", options?: ErrorOptions) {
    super(message, "token_refresh", options);
  }
}

export class RateLimitError extends ChatGPTOAuthError {
  constructor(readonly retryAfterMs?: number) {
    super("The service rate limit was reached.", "rate_limit");
  }
}

export class AuthError extends ChatGPTOAuthError {
  constructor(message = "Authentication was rejected.") { super(message, "auth"); }
}

export class TransportError extends ChatGPTOAuthError {
  constructor(message: string, options?: ErrorOptions) { super(message, "transport", options); }
}

export class DisabledError extends ChatGPTOAuthError {
  constructor() { super("ChatGPT subscription access is disabled.", "disabled"); }
}

export class StoreError extends ChatGPTOAuthError {
  constructor(message: string, options?: ErrorOptions) { super(message, "store", options); }
}

/**
 * Requires that `subject` is a nonempty server-derived identifier, shared by every credential entry
 * point. An empty subject would key one shared credential row for every user — the global row the
 * identity rule forbids. `StoreError` rather than `AuthError` because an empty subject is a
 * storage-key precondition, not a rejected authentication attempt.
 */
export function requireSubject(subject: string): void {
  if (subject.trim() === "") throw new StoreError("Credential subject must not be empty.");
}
