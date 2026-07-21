/** Coordinates subject-scoped refresh with singleflight, CAS, quarantine, and a kill switch. */
import { PROTOCOL, type ProtocolOverrides } from "./constants.js";
import { createOAuth } from "./oauth.js";
import { TokenEndpointFailure } from "./oauth.js";
import {
  AuthError,
  DisabledError,
  ReauthRequiredError,
  TokenRefreshError,
  type AuthSession,
  type CredentialStore,
  type Session,
  type TokenSet,
} from "./types.js";

export interface AuthSessionOptions {
  store: CredentialStore;
  fetch?: typeof fetch;
  crypto?: Crypto;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  disabled?: () => boolean;
  protocol?: ProtocolOverrides;
}

const flightsByStore = new WeakMap<CredentialStore, Map<string, Promise<TokenSet>>>();

function sessionFor(subject: string, token: TokenSet): Session {
  return {
    subject,
    status: token.quarantinedAt === undefined ? "connected" : "quarantined",
    expiresAt: token.expiresAt,
    ...(token.accountId === undefined ? {} : { accountId: token.accountId }),
    ...(token.planType === undefined ? {} : { planType: token.planType }),
    ...(token.email === undefined ? {} : { email: token.email }),
    ...(token.quarantineReason === undefined ? {} : { reason: token.quarantineReason }),
  };
}

export function createAuthSession(options: AuthSessionOptions): AuthSession {
  const now = options.now ?? Date.now;
  const oauth = createOAuth({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.crypto === undefined ? {} : { crypto: options.crypto }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    now,
  });
  const flights = flightsByStore.get(options.store) ?? new Map<string, Promise<TokenSet>>();
  flightsByStore.set(options.store, flights);

  async function persistFresh(subject: string, token: TokenSet): Promise<TokenSet> {
    const current = await options.store.load(subject);
    const expectedVersion = current?.version ?? 0;
    const next = { ...token, version: expectedVersion + 1 };
    const saved = await options.store.compareAndSwap(subject, expectedVersion, next);
    if (saved.ok) return next;
    if (saved.current !== null) return saved.current;
    throw new AuthError("Credentials changed while sign-in completed.");
  }

  async function quarantine(subject: string, token: TokenSet, reason: string): Promise<TokenSet> {
    const marker: TokenSet = {
      ...token,
      version: token.version + 1,
      quarantinedAt: now(),
      quarantineReason: reason,
    };
    const result = await options.store.compareAndSwap(subject, token.version, marker);
    const current = result.current;
    if (!result.ok && current !== null && current.quarantinedAt === undefined) {
      // A concurrent healthy rotation won; never quarantine that newer generation.
      return current;
    }
    throw new ReauthRequiredError(subject, current?.quarantineReason ?? reason);
  }

  async function refreshOne(subject: string, force: boolean): Promise<TokenSet> {
    const current = await options.store.load(subject);
    if (current === null) throw new ReauthRequiredError(subject, "missing_credentials");
    if (current.quarantinedAt !== undefined) {
      throw new ReauthRequiredError(subject, current.quarantineReason ?? "quarantined");
    }
    // The second load happens inside the flight; another process may already have rotated.
    if (!force && current.expiresAt - now() >= (options.protocol?.REFRESH_MARGIN_MS ?? PROTOCOL.REFRESH_MARGIN_MS)) return current;
    try {
      const next = await oauth.refresh(current);
      const swapped = await options.store.compareAndSwap(subject, current.version, next);
      if (swapped.ok) return next;
      if (swapped.current?.quarantinedAt !== undefined) {
        throw new ReauthRequiredError(subject, swapped.current.quarantineReason ?? "quarantined");
      }
      if (swapped.current !== null) return swapped.current;
      throw new ReauthRequiredError(subject, "credentials_deleted_during_refresh");
    } catch (error) {
      if (error instanceof TokenEndpointFailure && error.terminal) {
        return quarantine(subject, current, error.errorCode ?? `http_${error.status}`);
      }
      if (error instanceof TokenEndpointFailure) {
        throw new TokenRefreshError(`Token refresh failed (${error.status}).`, { cause: error });
      }
      throw error;
    }
  }

  function inFlight(subject: string, force: boolean): Promise<TokenSet> {
    const existing = flights.get(subject);
    if (existing !== undefined) return existing;
    // One promise per store+subject prevents an in-process refresh stampede.
    const created = refreshOne(subject, force).finally(() => { flights.delete(subject); });
    flights.set(subject, created);
    return created;
  }

  return {
    beginLogin: oauth.beginLogin,
    async completeLogin(subject, callbackUrl, pending) {
      return persistFresh(subject, await oauth.completeLogin(callbackUrl, pending));
    },
    async startDeviceLogin(subject) {
      return oauth.startDeviceLogin((token) => persistFresh(subject, token));
    },
    async getAccessToken(subject) {
      if (options.disabled?.() === true) throw new DisabledError();
      const token = await options.store.load(subject);
      if (token === null) throw new ReauthRequiredError(subject, "missing_credentials");
      if (token.quarantinedAt !== undefined) throw new ReauthRequiredError(subject, token.quarantineReason ?? "quarantined");
      if (token.expiresAt - now() >= (options.protocol?.REFRESH_MARGIN_MS ?? PROTOCOL.REFRESH_MARGIN_MS)) return token.accessToken;
      return (await inFlight(subject, false)).accessToken;
    },
    async refreshAccessToken(subject) {
      if (options.disabled?.() === true) throw new DisabledError();
      return (await inFlight(subject, true)).accessToken;
    },
    async status(subject) {
      const token = await options.store.load(subject);
      return token === null ? null : sessionFor(subject, token);
    },
    async logout(subject) { await options.store.delete(subject); },
  };
}
