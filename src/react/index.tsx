/** Supplies headless React auth state and an unstyled button that talks only to app routes. */
import {
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export interface AuthEndpoints {
  session: string;
  login: string;
  logout: string;
}

export interface BrowserSession {
  status: "connected";
  accountId?: string;
  planType?: string;
  email?: string;
}

export interface ChatGPTAuthState {
  session: BrowserSession | null;
  loading: boolean;
  error: Error | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

export function useChatGPTAuth({ endpoints }: { endpoints: AuthEndpoints }): ChatGPTAuthState {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoints.session, { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 404) { setSession(null); return; }
      if (!response.ok) throw new Error(`Session request failed (${response.status}).`);
      const payload: unknown = await response.json();
      if (payload === null || typeof payload !== "object") throw new Error("Session route returned invalid metadata.");
      const data = payload as Record<string, unknown>;
      if (data.status !== "connected") throw new Error("Session route returned invalid metadata.");
      const safe: BrowserSession = {
        status: "connected",
        ...(typeof data.accountId === "string" ? { accountId: data.accountId } : {}),
        ...(typeof data.planType === "string" ? { planType: data.planType } : {}),
        ...(typeof data.email === "string" ? { email: data.email } : {}),
      };
      setSession(safe);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Session request failed."));
    } finally { setLoading(false); }
  }, [endpoints.session]);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoints.login, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-in request failed (${response.status}).`);
      const payload = await response.json() as { url?: unknown };
      if (typeof payload.url !== "string") throw new Error("Sign-in route omitted the authorization URL.");
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Sign-in request failed."));
      setLoading(false);
    }
  }, [endpoints.login]);

  const signOut = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(endpoints.logout, { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error(`Sign-out request failed (${response.status}).`);
      setSession(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Sign-out request failed."));
    } finally { setLoading(false); }
  }, [endpoints.logout]);

  return { session, loading, error, signIn, signOut, refresh };
}

export interface SignInWithChatGPTProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> {
  endpoints: AuthEndpoints;
  children?: ReactNode;
  render?: (auth: ChatGPTAuthState) => ReactNode;
}

export function SignInWithChatGPT({ endpoints, render, children, ...button }: SignInWithChatGPTProps) {
  const auth = useChatGPTAuth({ endpoints });
  if (render !== undefined) return render(auth);
  return (
    <button type="button" {...button} disabled={button.disabled === true || auth.loading} onClick={() => { void auth.signIn(); }}>
      {children ?? (auth.loading ? "Connecting…" : "Sign in with ChatGPT")}
    </button>
  );
}
