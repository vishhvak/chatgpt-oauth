/** Coordinates subject-scoped refresh with singleflight, CAS, quarantine, and a kill switch. */
import { PROTOCOL, type ProtocolOverrides } from "./constants.js";
import { createOAuth } from "./oauth.js";
import { TokenEndpointFailure } from "./oauth.js";
import {
  AuthError,
  DisabledError,
  ReauthRequiredError,
  TokenRefreshError,
  requireSubject,
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

interface RefreshResult {
  token: TokenSet;
  refreshed: boolean;
}

interface RefreshFlight {
  force: boolean;
  promise: Promise<RefreshResult>;
}

const flightsByStore = new WeakMap<CredentialStore, Map<string, RefreshFlight>>();

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
  const flights = flightsByStore.get(options.store) ?? new Map<string, RefreshFlight>();
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

  async function refreshOne(subject: string, force: boolean): Promise<RefreshResult> {
    const current = await options.store.load(subject);
    if (current === null) throw new ReauthRequiredError(subject, "missing_credentials");
    if (current.quarantinedAt !== undefined) {
      throw new ReauthRequiredError(subject, current.quarantineReason ?? "quarantined");
    }
    // The second load happens inside the flight; another process may already have rotated.
    if (!force && current.expiresAt - now() >= (options.protocol?.REFRESH_MARGIN_MS ?? PROTOCOL.REFRESH_MARGIN_MS)) {
      return { token: current, refreshed: false };
    }
    try {
      const next = await oauth.refresh(current);
      const swapped = await options.store.compareAndSwap(subject, current.version, next);
      if (swapped.ok) return { token: next, refreshed: true };
      if (swapped.current?.quarantinedAt !== undefined) {
        throw new ReauthRequiredError(subject, swapped.current.quarantineReason ?? "quarantined");
      }
      if (swapped.current !== null) return { token: swapped.current, refreshed: true };
      throw new ReauthRequiredError(subject, "credentials_deleted_during_refresh");
    } catch (error) {
      if (error instanceof TokenEndpointFailure && error.terminal) {
        return { token: await quarantine(subject, current, error.errorCode ?? `http_${error.status}`), refreshed: true };
      }
      if (error instanceof TokenEndpointFailure) {
        throw new TokenRefreshError(`Token refresh failed (${error.status}).`, { cause: error });
      }
      throw error;
    }
  }

  function inFlight(subject: string, force: boolean): Promise<RefreshResult> {
    const existing = flights.get(subject);
    if (existing !== undefined) {
      if (!force || existing.force) return existing.promise;
      // A forced 401 retry may share a real refresh, but must not settle on a non-force flight that skipped the network.
      return existing.promise.then((result) => result.refreshed ? result : inFlight(subject, true));
    }
    // One promise per store+subject prevents an in-process refresh stampede.
    const created: RefreshFlight = {
      force,
      promise: refreshOne(subject, force).finally(() => {
        if (flights.get(subject) === created) flights.delete(subject);
      }),
    };
    flights.set(subject, created);
    return created.promise;
  }

  function assertEnabled(): void {
    if (options.disabled?.() === true) throw new DisabledError();
  }

  async function getTokenSet(subject: string, forceRefresh = false): Promise<TokenSet> {
    requireSubject(subject);
    assertEnabled();
    if (forceRefresh) return (await inFlight(subject, true)).token;
    // One load carries both the freshness check and, when already fresh, the whole token set.
    const token = await options.store.load(subject);
    if (token === null) throw new ReauthRequiredError(subject, "missing_credentials");
    if (token.quarantinedAt !== undefined) throw new ReauthRequiredError(subject, token.quarantineReason ?? "quarantined");
    if (token.expiresAt - now() >= (options.protocol?.REFRESH_MARGIN_MS ?? PROTOCOL.REFRESH_MARGIN_MS)) return token;
    return (await inFlight(subject, false)).token;
  }

  return {
    // beginLogin takes no subject and touches neither store nor network, so it is deliberately
    // unguarded — matching the Kotlin and Swift ports.
    beginLogin: oauth.beginLogin,
    async completeLogin(subject, callbackUrl, pending) {
      requireSubject(subject);
      assertEnabled();
      return persistFresh(subject, await oauth.completeLogin(callbackUrl, pending));
    },
    async startDeviceLogin(subject) {
      requireSubject(subject);
      assertEnabled();
      return oauth.startDeviceLogin((token) => {
        // Device polling runs for minutes; the kill switch can flip before the exchange lands.
        assertEnabled();
        return persistFresh(subject, token);
      });
    },
    getTokenSet,
    async getAccessToken(subject) {
      return (await getTokenSet(subject)).accessToken;
    },
    async refreshAccessToken(subject) {
      return (await getTokenSet(subject, true)).accessToken;
    },
    async status(subject) {
      requireSubject(subject);
      assertEnabled();
      const token = await options.store.load(subject);
      return token === null ? null : sessionFor(subject, token);
    },
    // logout stays reachable while disabled: a kill switch that traps credentials in the store with
    // no way to remove them is worse than one that lets them out. All four ports agree.
    async logout(subject) {
      requireSubject(subject);
      await options.store.delete(subject);
    },
  };
}
