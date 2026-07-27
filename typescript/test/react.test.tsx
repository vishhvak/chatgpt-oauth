// @vitest-environment jsdom
/** Pins the browser hook state machine and the styled component contract. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGPTUsage, SignInWithChatGPT, useChatGPTAuth } from "../src/react/index.js";

const endpoints = { session: "/auth/session", login: "/auth/login", logout: "/auth/logout" };

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById("chatgpt-oauth-styles")?.remove();
});

describe("React web auth", () => {
  it("moves loading → signed-out → connecting → connected through popup polling", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(reply(200, { status: "disconnected" }))
      .mockResolvedValueOnce(reply(200, { url: "https://auth.example/authorize" }))
      .mockResolvedValueOnce(reply(200, { status: "connected", email: "v@example.com", planType: "plus" }));
    vi.stubGlobal("fetch", request);
    const popup = { closed: false, close: vi.fn(), location: { href: "" } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useChatGPTAuth({ endpoints, pollIntervalMs: 1 }));

    expect(result.current.status).toBe("loading");
    await waitFor(() => { expect(result.current.status).toBe("signed-out"); });
    let login!: Promise<void>;
    act(() => { login = result.current.login(); });
    expect(result.current.status).toBe("connecting");
    await act(async () => { await login; });

    expect(result.current.status).toBe("connected");
    expect(result.current.email).toBe("v@example.com");
    expect(result.current.plan).toBe("plus");
    expect(result.current.session).toEqual({ status: "connected", email: "v@example.com", planType: "plus" });
    expect(popup.location.href).toBe("https://auth.example/authorize");
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("moves connecting → error when the login route fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reply(200, { status: "disconnected" }))
      .mockResolvedValueOnce(reply(500)));
    const popup = { closed: false, close: vi.fn(), location: { href: "" } };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const { result } = renderHook(() => useChatGPTAuth({ endpoints }));
    await waitFor(() => { expect(result.current.status).toBe("signed-out"); });

    await act(async () => { await result.current.login(); });
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("Sign-in request failed (500).");
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("moves connected → loading → signed-out on logout", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reply(200, { status: "connected", email: "v@example.com" }))
      .mockResolvedValueOnce(reply(200, { ok: true })));
    const { result } = renderHook(() => useChatGPTAuth({ endpoints }));
    await waitFor(() => { expect(result.current.status).toBe("connected"); });

    let logout!: Promise<void>;
    act(() => { logout = result.current.logout(); });
    expect(result.current.status).toBe("loading");
    await act(async () => { await logout; });
    expect(result.current.status).toBe("signed-out");
    expect(result.current.session).toBeNull();
  });

  it("notifies onConnected and onError from the transition, not from an effect", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(reply(200, { status: "connected", email: "v@example.com" }))
      .mockResolvedValueOnce(reply(500)));
    const onConnected = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useChatGPTAuth({ endpoints, onConnected, onError }));

    await waitFor(() => { expect(result.current.status).toBe("connected"); });
    expect(onConnected).toHaveBeenCalledExactlyOnceWith({ status: "connected", email: "v@example.com" });
    expect(onError).not.toHaveBeenCalled();

    await act(async () => { await result.current.refresh(); });
    expect(result.current.status).toBe("error");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("forwards the component's onConnected prop through to the hook", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, { status: "connected", email: "v@example.com", planType: "pro" })));
    const onConnected = vi.fn();
    render(<SignInWithChatGPT endpoints={endpoints} onConnected={onConnected} />);

    expect(await screen.findByText("v@example.com")).toBeTruthy();
    expect(onConnected).toHaveBeenCalledExactlyOnceWith({ status: "connected", email: "v@example.com", planType: "pro" });
  });

  it("renders signed-out, connected, disclaimer, and render-override states", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(reply(200, { status: "disconnected" }))
      .mockResolvedValueOnce(reply(200, { status: "connected", email: "v@example.com", planType: "pro" }))
      .mockResolvedValueOnce(reply(200, { status: "disconnected" }));
    vi.stubGlobal("fetch", request);

    const signedOut = render(<SignInWithChatGPT endpoints={endpoints} />);
    expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeTruthy();
    expect(screen.getByText(/Experimental: this uses OpenAI’s Codex OAuth client/)).toBeTruthy();
    signedOut.unmount();

    const connected = render(<SignInWithChatGPT endpoints={endpoints} showDisclaimer={false} />);
    expect(await screen.findByText("v@example.com")).toBeTruthy();
    expect(screen.getByText("pro")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText(/Experimental:/)).toBeNull();
    connected.unmount();

    render(<SignInWithChatGPT endpoints={endpoints} render={(state) => <span>Override: {state.status}</span>} />);
    expect(await screen.findByText("Override: signed-out")).toBeTruthy();
    expect(document.querySelector(".cgpt-root")).toBeNull();
  });

  it("injects one scoped stylesheet and imports no CSS framework or icon library", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, { status: "disconnected" })));
    render(<><SignInWithChatGPT endpoints={endpoints} /><SignInWithChatGPT endpoints={endpoints} /></>);
    await screen.findAllByRole("button", { name: "Sign in with ChatGPT" });
    expect(document.querySelectorAll("#chatgpt-oauth-styles")).toHaveLength(1);
    const css = document.getElementById("chatgpt-oauth-styles")?.textContent ?? "";
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("prefers-reduced-motion");
    for (const variable of ["--cgpt-bg", "--cgpt-fg", "--cgpt-border", "--cgpt-radius", "--cgpt-accent", "--cgpt-muted"]) {
      expect(css).toContain(variable);
    }

    const directory = join(process.cwd(), "src/react");
    const source = `${await readFile(join(directory, "index.tsx"), "utf8")}\n${await readFile(join(directory, "styles.ts"), "utf8")}`;
    expect(source).not.toMatch(/from ["'](?:tailwind|bootstrap|lucide|react-icons|@fortawesome)/u);
    expect(source).toContain("M22.28 9.82");
    expect(source).not.toContain("<circle");
    expect(source).toContain("fill: currentColor");
  });

  it("renders usage meters, reset countdowns, and a plan badge", async () => {
    const future = Math.floor(Date.now() / 1_000) + 3_600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, {
      primary: { usedPercent: 25, windowMinutes: 300, resetsAt: future },
      secondary: { usedPercent: 70, windowMinutes: 10_080, resetsAt: future + 3_600 },
      planType: "pro",
      limitName: "Codex",
    })));
    render(<ChatGPTUsage endpoints={{ usage: "/api/chatgpt/usage" }} refreshIntervalMs={0} />);

    expect(await screen.findByText("pro")).toBeTruthy();
    const meters = screen.getAllByRole("progressbar");
    expect(meters).toHaveLength(2);
    expect(meters[0]?.getAttribute("aria-valuenow")).toBe("25");
    expect(meters[1]?.getAttribute("aria-valuenow")).toBe("70");
    expect(screen.getByText("5 hour limit")).toBeTruthy();
    expect(screen.getByText("1 day limit")).toBeTruthy();
    expect(screen.getAllByText(/Resets in \d+h/)).toHaveLength(2);
  });

  it("handles usage loading, empty, and error states", async () => {
    const pending = new Promise<Response>(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));
    const loading = render(<ChatGPTUsage endpoints={{ usage: "/usage" }} refreshIntervalMs={0} />);
    expect(screen.getByText("Loading usage…")).toBeTruthy();
    loading.unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, {})));
    const empty = render(<ChatGPTUsage endpoints={{ usage: "/usage" }} refreshIntervalMs={0} />);
    expect(await screen.findByText(/Usage becomes available/)).toBeTruthy();
    empty.unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(500)));
    render(<ChatGPTUsage endpoints={{ usage: "/usage" }} refreshIntervalMs={0} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Usage request failed (500).");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
