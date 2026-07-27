/** Supplies browser-only auth state and a polished shell that never handles tokens. */
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { RateLimitSnapshot, RateLimitWindow } from "../core/types.js";
import { CHATGPT_AUTH_STYLES } from "./styles.js";

export interface AuthEndpoints {
  session: string;
  login: string;
  logout: string;
}

export interface BrowserSession {
  status: "connected";
  planType?: string;
  email?: string;
}

export type ChatGPTAuthStatus = "loading" | "signed-out" | "connecting" | "connected" | "error";
export type ChatGPTAuthMode = "popup" | "redirect";

export interface ChatGPTAuthState {
  status: ChatGPTAuthStatus;
  account?: BrowserSession;
  plan?: string;
  email?: string;
  error?: Error;
  login(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  /** @deprecated Use account. */
  session: BrowserSession | null;
  /** @deprecated Read status instead. */
  loading: boolean;
  /** @deprecated Use login(). */
  signIn(): Promise<void>;
  /** @deprecated Use logout(). */
  signOut(): Promise<void>;
}

export interface UseChatGPTAuthOptions {
  endpoints: AuthEndpoints;
  mode?: ChatGPTAuthMode;
  /** Intended for deterministic tests; most applications should use the default. */
  pollIntervalMs?: number;
  /** Intended for deterministic tests; most applications should use the default. */
  pollTimeoutMs?: number;
  /**
   * Fired at the moment the hook settles on a connected account. Notifying from
   * the transition rather than from an effect keeps the parent's update in the
   * same commit instead of costing every consumer a second render.
   */
  onConnected?(session: BrowserSession): void;
  /** Fired at the moment the hook settles on a failure. */
  onError?(error: Error): void;
}

interface AuthView {
  status: ChatGPTAuthStatus;
  session: BrowserSession | null;
  error?: Error;
}

function failure(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

async function readSafeSession(endpoint: string): Promise<BrowserSession | null> {
  const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Session request failed (${response.status}).`);
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Session route returned invalid metadata.");
  }
  const data = payload as Record<string, unknown>;
  const allowed = new Set(["status", "email", "planType"]);
  if (Object.keys(data).some((key) => !allowed.has(key))) {
    throw new Error("Session route returned unsafe metadata.");
  }
  if (data.status === "disconnected" || data.status === "signed-out") return null;
  if (data.status !== "connected") throw new Error("Session route returned invalid metadata.");
  if (data.email !== undefined && data.email !== null && typeof data.email !== "string") {
    throw new Error("Session route returned invalid metadata.");
  }
  if (data.planType !== undefined && data.planType !== null && typeof data.planType !== "string") {
    throw new Error("Session route returned invalid metadata.");
  }
  return {
    status: "connected",
    ...(typeof data.email === "string" ? { email: data.email } : {}),
    ...(typeof data.planType === "string" ? { planType: data.planType } : {}),
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

export function useChatGPTAuth({
  endpoints,
  mode = "popup",
  pollIntervalMs = 1_000,
  pollTimeoutMs = 2 * 60_000,
  onConnected,
  onError,
}: UseChatGPTAuthOptions): ChatGPTAuthState {
  const [view, setView] = useState<AuthView>({ status: "loading", session: null });
  const operation = useRef(0);
  const popup = useRef<Window | null>(null);

  // Latest-callback ref: consumers routinely pass inline closures, and reading
  // them through a ref keeps them out of every useCallback dependency list.
  const handlers = useRef<{ onConnected: UseChatGPTAuthOptions["onConnected"]; onError: UseChatGPTAuthOptions["onError"] }>({ onConnected, onError });
  useInsertionEffect(() => { handlers.current = { onConnected, onError }; }, [onConnected, onError]);

  /** Commits a terminal view and notifies the consumer in the same turn. */
  const settle = useCallback((next: AuthView) => {
    setView(next);
    if (next.status === "connected" && next.session !== null) handlers.current.onConnected?.(next.session);
    else if (next.status === "error" && next.error !== undefined) handlers.current.onError?.(next.error);
  }, []);

  const refresh = useCallback(async () => {
    const current = ++operation.current;
    popup.current?.close();
    popup.current = null;
    setView((previous) => ({ status: "loading", session: previous.session }));
    try {
      const session = await readSafeSession(endpoints.session);
      if (operation.current === current) settle({ status: session === null ? "signed-out" : "connected", session });
    } catch (cause) {
      if (operation.current === current) settle({ status: "error", session: null, error: failure(cause, "Session request failed.") });
    }
  }, [endpoints.session, settle]);

  useEffect(() => {
    void refresh();
    return () => {
      operation.current += 1;
      popup.current?.close();
      popup.current = null;
    };
  }, [refresh]);

  const login = useCallback(async () => {
    const current = ++operation.current;
    // Open synchronously while the click still has browser activation; awaiting
    // the login route first makes otherwise-valid popups look blocked.
    const loginWindow = mode === "popup"
      ? window.open("", "chatgpt-oauth", "popup,width=520,height=720,resizable=yes,scrollbars=yes")
      : null;
    popup.current = loginWindow;
    setView({ status: "connecting", session: null });
    try {
      if (mode === "popup" && loginWindow === null) throw new Error("The sign-in window was blocked. Allow popups and try again.");
      const response = await fetch(endpoints.login, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-in request failed (${response.status}).`);
      const payload: unknown = await response.json();
      const url = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).url : undefined;
      if (typeof url !== "string") throw new Error("Sign-in route omitted the authorization URL.");
      if (operation.current !== current) { loginWindow?.close(); return; }
      if (mode === "redirect") {
        window.location.assign(url);
        return;
      }
      if (loginWindow === null) return;
      loginWindow.location.href = url;
      const deadline = Date.now() + pollTimeoutMs;
      while (operation.current === current && Date.now() < deadline) {
        const session = await readSafeSession(endpoints.session);
        if (operation.current !== current) return;
        if (session !== null) {
          loginWindow.close();
          popup.current = null;
          settle({ status: "connected", session });
          return;
        }
        if (loginWindow.closed) throw new Error("The sign-in window closed before ChatGPT connected.");
        await pause(pollIntervalMs);
      }
      if (operation.current === current) throw new Error("ChatGPT sign-in timed out. Try again.");
    } catch (cause) {
      loginWindow?.close();
      if (popup.current === loginWindow) popup.current = null;
      if (operation.current === current) {
        settle({ status: "error", session: null, error: failure(cause, "Sign-in failed.") });
      }
    }
  }, [endpoints.login, endpoints.session, mode, pollIntervalMs, pollTimeoutMs, settle]);

  const logout = useCallback(async () => {
    const current = ++operation.current;
    popup.current?.close();
    popup.current = null;
    setView((previous) => ({ status: "loading", session: previous.session }));
    try {
      const response = await fetch(endpoints.logout, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-out request failed (${response.status}).`);
      if (operation.current === current) setView({ status: "signed-out", session: null });
    } catch (cause) {
      if (operation.current === current) {
        settle({ status: "error", session: view.session, error: failure(cause, "Sign-out failed.") });
      }
    }
  }, [endpoints.logout, settle, view.session]);

  return {
    status: view.status,
    ...(view.session === null ? {} : {
      account: view.session,
      ...(view.session.planType === undefined ? {} : { plan: view.session.planType }),
      ...(view.session.email === undefined ? {} : { email: view.session.email }),
    }),
    ...(view.error === undefined ? {} : { error: view.error }),
    login,
    logout,
    refresh,
    session: view.session,
    loading: view.status === "loading" || view.status === "connecting",
    signIn: login,
    signOut: logout,
  };
}

export interface SignInWithChatGPTProps {
  endpoints: AuthEndpoints;
  label?: string;
  theme?: "auto" | "light" | "dark";
  showDisclaimer?: boolean;
  mode?: ChatGPTAuthMode;
  className?: string;
  style?: CSSProperties;
  onConnected?(session: BrowserSession): void;
  onError?(error: Error): void;
  render?: (auth: ChatGPTAuthState) => ReactNode;
}

function OpenAIMark(): ReactNode {
  return (
    <svg aria-hidden="true" className="cgpt-mark" focusable="false" viewBox="0 0 24 24">
      {/* OpenAI wordmark, trademark of OpenAI; used to label the sign-in affordance. */}
      <path d="M22.28 9.82a5.98 5.98 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.98 5.98 0 0 0-4 2.9 6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79 .79 0 0 0 .39-.68v-6.74l2.02 1.17a.07 .07 0 0 1 .04 .05v5.58a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14 .09 4.78 2.76a.77 .77 0 0 0 .78 0l5.84-3.37v2.33a.08 .08 0 0 1-.03 .06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97V11.6a.77 .77 0 0 0 .39 .68l5.81 3.35-2.02 1.17a.08 .08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87zm16.6 3.86L13.1 8.36 15.12 7.2a.08 .08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79 .79 0 0 0-.41-.67zm2.01-3.02l-.14-.09-4.77-2.78a.78 .78 0 0 0-.79 0L9.41 9.23V6.9a.07 .07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08 .08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14 .08L8.7 5.46a.79 .79 0 0 0-.39 .68zm1.1-2.37l2.6-1.5 2.61 1.5v3l-2.6 1.5-2.61-1.5Z" />
    </svg>
  );
}

function Spinner(): ReactNode {
  return <span aria-hidden="true" className="cgpt-spinner" />;
}

function injectStyles(): void {
  if (document.getElementById("chatgpt-oauth-styles") !== null) return;
  const stylesheet = document.createElement("style");
  stylesheet.id = "chatgpt-oauth-styles";
  stylesheet.textContent = CHATGPT_AUTH_STYLES;
  document.head.append(stylesheet);
}

export function SignInWithChatGPT({
  endpoints,
  label = "Sign in with ChatGPT",
  theme = "auto",
  showDisclaimer = true,
  mode = "popup",
  className,
  style,
  onConnected,
  onError,
  render,
}: SignInWithChatGPTProps): ReactNode {
  const auth = useChatGPTAuth({
    endpoints,
    mode,
    ...(onConnected === undefined ? {} : { onConnected }),
    ...(onError === undefined ? {} : { onError }),
  });

  useInsertionEffect(() => {
    if (render === undefined) injectStyles();
  }, [render]);

  if (render !== undefined) return render(auth);

  const classes = ["cgpt-root", `cgpt-theme-${theme}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} style={style}>
      <div aria-live="polite" aria-atomic="true" className="cgpt-status" role="status">
        {auth.status === "connected" && auth.account !== undefined ? (
          <div className="cgpt-connected">
            <div className="cgpt-identity" title={auth.email ?? "Connected to ChatGPT"}>
              <OpenAIMark />
              <span className="cgpt-identity-copy">
                <strong>{auth.email ?? "Connected to ChatGPT"}</strong>
                {auth.plan === undefined ? null : <span>{auth.plan}</span>}
              </span>
            </div>
            <button className="cgpt-signout" type="button" onClick={() => { void auth.logout(); }}>
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8 4H4.75A1.75 1.75 0 0 0 3 5.75v8.5C3 15.22 3.78 16 4.75 16H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" /></svg>
              Sign out
            </button>
          </div>
        ) : auth.status === "connecting" || auth.status === "loading" ? (
          <button className="cgpt-button" type="button" disabled>
            <Spinner />
            {auth.status === "connecting" ? "Waiting for ChatGPT…" : "Checking ChatGPT…"}
          </button>
        ) : (
          <div className="cgpt-action-stack">
            {auth.status === "error" ? <span className="cgpt-error" role="alert">{auth.error?.message ?? "Unable to connect."}</span> : null}
            <button className="cgpt-button" type="button" onClick={() => { void auth.login(); }}>
              <OpenAIMark />
              {auth.status === "error" ? "Try again" : label}
            </button>
          </div>
        )}
      </div>
      {showDisclaimer ? (
        <p className="cgpt-disclaimer">
          Experimental: this uses OpenAI’s Codex OAuth client for ChatGPT subscription access. It may violate OpenAI ToS for non-Codex use and can break at any time.
        </p>
      ) : null}
    </div>
  );
}

export interface UsageEndpoints { usage: string }
export type ChatGPTUsageStatus = "loading" | "ready" | "empty" | "error";

export interface ChatGPTUsageState {
  status: ChatGPTUsageStatus;
  snapshot?: RateLimitSnapshot;
  error?: Error;
  refresh(): Promise<void>;
}

export interface ChatGPTUsageProps {
  endpoints: UsageEndpoints;
  theme?: "auto" | "light" | "dark";
  refreshIntervalMs?: number;
  className?: string;
  style?: CSSProperties;
  render?: (state: ChatGPTUsageState) => ReactNode;
}

function usageWindow(value: unknown): RateLimitWindow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.usedPercent !== "number" || !Number.isFinite(source.usedPercent)) return undefined;
  const windowMinutes = typeof source.windowMinutes === "number" && Number.isFinite(source.windowMinutes) ? source.windowMinutes : undefined;
  const resetsAt = typeof source.resetsAt === "number" && Number.isFinite(source.resetsAt) ? source.resetsAt : undefined;
  return {
    usedPercent: source.usedPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function safeUsage(value: unknown): RateLimitSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Usage route returned invalid metadata.");
  const source = value as Record<string, unknown>;
  const primary = usageWindow(source.primary);
  const secondary = usageWindow(source.secondary);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(typeof source.planType === "string" ? { planType: source.planType } : {}),
    ...(typeof source.limitName === "string" ? { limitName: source.limitName } : {}),
  };
}

function windowLabel(name: "Primary" | "Secondary", minutes: number | undefined): string {
  if (minutes === undefined) return name;
  if (minutes % 10_080 === 0) return `${minutes / 10_080} day limit`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} day limit`;
  if (minutes % 60 === 0) return `${minutes / 60} hour limit`;
  return `${minutes} minute limit`;
}

function resetLabel(resetsAt: number | undefined, now: number): string | undefined {
  if (resetsAt === undefined) return undefined;
  const remainingMinutes = Math.max(0, Math.ceil((resetsAt * 1_000 - now) / 60_000));
  if (remainingMinutes === 0) return "Resetting now";
  if (remainingMinutes < 60) return `Resets in ${remainingMinutes}m`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return `Resets in ${hours}h${minutes === 0 ? "" : ` ${minutes}m`}`;
}

function UsageMeter({ name, window, now }: { name: "Primary" | "Secondary"; window: RateLimitWindow; now: number }): ReactNode {
  const percent = Math.min(100, Math.max(0, window.usedPercent));
  const reset = resetLabel(window.resetsAt, now);
  const label = windowLabel(name, window.windowMinutes);
  return (
    <div className="cgpt-usage-window">
      <div className="cgpt-usage-label"><span>{label}</span><strong>{Math.round(window.usedPercent)}% used</strong></div>
      <div
        aria-label={`${label}: ${Math.round(window.usedPercent)}% used`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="cgpt-usage-meter"
        role="progressbar"
      >
        <span className="cgpt-usage-fill" style={{ width: `${percent}%` }} />
      </div>
      {reset === undefined ? null : <span className="cgpt-usage-reset">{reset}</span>}
    </div>
  );
}

export function ChatGPTUsage({
  endpoints,
  theme = "auto",
  refreshIntervalMs = 60_000,
  className,
  style,
  render,
}: ChatGPTUsageProps): ReactNode {
  const [view, setView] = useState<Omit<ChatGPTUsageState, "refresh">>({ status: "loading" });
  const [now, setNow] = useState(Date.now);
  const operation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++operation.current;
    setView((previous) => ({ status: previous.snapshot === undefined ? "loading" : previous.status, ...(previous.snapshot === undefined ? {} : { snapshot: previous.snapshot }) }));
    try {
      const response = await fetch(endpoints.usage, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 404) {
        if (operation.current === current) setView({ status: "empty", snapshot: {} });
        return;
      }
      if (!response.ok) throw new Error(`Usage request failed (${response.status}).`);
      const snapshot = safeUsage(await response.json());
      if (operation.current === current) {
        setView({ status: snapshot.primary === undefined && snapshot.secondary === undefined ? "empty" : "ready", snapshot });
      }
    } catch (cause) {
      if (operation.current === current) setView({ status: "error", error: failure(cause, "Usage request failed.") });
    }
  }, [endpoints.usage]);

  useInsertionEffect(() => {
    if (render === undefined) injectStyles();
  }, [render]);
  useEffect(() => {
    void refresh();
    const refreshTimer = refreshIntervalMs > 0 ? window.setInterval(() => { void refresh(); }, refreshIntervalMs) : undefined;
    const clockTimer = window.setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => {
      operation.current += 1;
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refresh, refreshIntervalMs]);

  const state: ChatGPTUsageState = { ...view, refresh };
  if (render !== undefined) return render(state);

  const classes = ["cgpt-root", "cgpt-usage", `cgpt-theme-${theme}`, className].filter(Boolean).join(" ");
  return (
    <section aria-label="ChatGPT usage" className={classes} style={style}>
      <div className="cgpt-usage-heading">
        <div><span className="cgpt-usage-eyebrow">ChatGPT</span><h2>Usage limits</h2></div>
        {view.snapshot?.planType === undefined ? null : <span className="cgpt-plan-badge">{view.snapshot.planType}</span>}
      </div>
      {view.status === "loading" ? <div aria-live="polite" className="cgpt-usage-state" role="status"><Spinner /> Loading usage…</div> : null}
      {view.status === "error" ? (
        <div className="cgpt-usage-state cgpt-usage-error" role="alert">
          <span>{view.error?.message ?? "Unable to load usage."}</span>
          <button type="button" onClick={() => { void refresh(); }}>Retry</button>
        </div>
      ) : null}
      {view.status === "empty" ? <p className="cgpt-usage-empty">Usage becomes available after you sign in and send a request.</p> : null}
      {view.status === "ready" && view.snapshot !== undefined ? (
        <div className="cgpt-usage-windows">
          {view.snapshot.primary === undefined ? null : <UsageMeter name="Primary" now={now} window={view.snapshot.primary} />}
          {view.snapshot.secondary === undefined ? null : <UsageMeter name="Secondary" now={now} window={view.snapshot.secondary} />}
        </div>
      ) : null}
    </section>
  );
}
