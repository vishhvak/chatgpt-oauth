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
}: UseChatGPTAuthOptions): ChatGPTAuthState {
  const [view, setView] = useState<AuthView>({ status: "loading", session: null });
  const operation = useRef(0);
  const popup = useRef<Window | null>(null);

  const refresh = useCallback(async () => {
    const current = ++operation.current;
    popup.current?.close();
    popup.current = null;
    setView((previous) => ({ status: "loading", session: previous.session }));
    try {
      const session = await readSafeSession(endpoints.session);
      if (operation.current === current) setView({ status: session === null ? "signed-out" : "connected", session });
    } catch (cause) {
      if (operation.current === current) setView({ status: "error", session: null, error: failure(cause, "Session request failed.") });
    }
  }, [endpoints.session]);

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
          setView({ status: "connected", session });
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
        setView({ status: "error", session: null, error: failure(cause, "Sign-in failed.") });
      }
    }
  }, [endpoints.login, endpoints.session, mode, pollIntervalMs, pollTimeoutMs]);

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
        setView({ status: "error", session: view.session, error: failure(cause, "Sign-out failed.") });
      }
    }
  }, [endpoints.logout, view.session]);

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
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
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
  const auth = useChatGPTAuth({ endpoints, mode });
  const lastConnected = useRef<BrowserSession | null>(null);
  const lastError = useRef<Error | null>(null);

  useInsertionEffect(() => {
    if (render === undefined) injectStyles();
  }, [render]);
  useEffect(() => {
    if (auth.status !== "connected" || auth.account === undefined || lastConnected.current === auth.account) return;
    lastConnected.current = auth.account;
    onConnected?.(auth.account);
  }, [auth.account, auth.status, onConnected]);
  useEffect(() => {
    if (auth.status !== "error" || auth.error === undefined || lastError.current === auth.error) return;
    lastError.current = auth.error;
    onError?.(auth.error);
  }, [auth.error, auth.status, onError]);

  if (render !== undefined) return render(auth);

  const classes = ["cgpt-root", `cgpt-theme-${theme}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} style={style}>
      <div aria-live="polite" aria-atomic="true" className="cgpt-status" role="status">
        {auth.status === "connected" && auth.account !== undefined ? (
          <div className="cgpt-connected">
            <div className="cgpt-identity" title={auth.email ?? "Connected to ChatGPT"}>
              {OpenAIMark()}
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
              {OpenAIMark()}
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
