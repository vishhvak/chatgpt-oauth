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
      <g fill="none" stroke="currentColor" strokeWidth="1.55">
        <circle cx="12" cy="6.5" r="3.55" />
        <circle cx="16.75" cy="9.25" r="3.55" />
        <circle cx="16.75" cy="14.75" r="3.55" />
        <circle cx="12" cy="17.5" r="3.55" />
        <circle cx="7.25" cy="14.75" r="3.55" />
        <circle cx="7.25" cy="9.25" r="3.55" />
      </g>
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
